"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHotspotService } = require("../lib/hotspot-service");

const HOST_WALLET = "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-unit-"));
}

function makeService(overrides = {}) {
  return createHotspotService({
    dataDir: tmpDir(),
    localIp: "192.168.2.1",
    hostWallet: HOST_WALLET,
    verifyPayment: async ({ signature, reference }) => ({
      signature,
      buyerWallet: "buyer-wallet",
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      reference,
    }),
    sendRefund: async ({ amountLamports }) => ({
      status: amountLamports > 0 ? "sent" : "not_needed",
      signature: amountLamports > 0 ? "refund-sig" : null,
      explorerUrl: amountLamports > 0
        ? "https://explorer.solana.com/tx/refund-sig?cluster=devnet"
        : null,
      sourceWallet: amountLamports > 0 ? "refund-wallet" : null,
    }),
    ...overrides,
  });
}

test("idempotency: fulfillIntent called twice with the same reference returns the same session", async () => {
  // The intent gets a `fulfilledSessionId` after the first call (see
  // hotspot-service.js around line 841); subsequent calls hit the early
  // return at line 799 and never re-run createSession.
  const service = makeService();
  const intent = service.buildIntent({
    ip: "10.0.0.91",
    minutes: 5,
    listingId: "local-hotspot",
    buyerWallet: "agent-buyer",
    tier: "standard",
    action: "purchase",
  });

  const first = await service.fulfillIntent({
    reference: intent.reference,
    signature: "agent-sig-1",
    buyerWallet: "agent-buyer",
  });
  // Capture before the second call — accidental re-runs would mutate the
  // session in-place via createSession's "extend" branch.
  const firstSessionId = first.session.session_id;
  const firstMinutes = first.session.minutes_purchased;
  assert.equal(firstMinutes, 5);

  const second = await service.fulfillIntent({
    reference: intent.reference,
    signature: "agent-sig-2",
    buyerWallet: "agent-buyer",
  });

  assert.equal(second.session.session_id, firstSessionId);
  assert.equal(
    second.session.minutes_purchased,
    firstMinutes,
    "minutes_purchased must not change on retry"
  );
  // Idempotent path returns the original signature, not the retry's.
  assert.equal(second.session.tx_hash, "agent-sig-1");

  // The session list still has exactly one session for this IP.
  const matches = service.listSessions().filter((s) => s.ip === "10.0.0.91");
  assert.equal(matches.length, 1);
});

test("refund math: 10-minute session disconnected at 4 minutes refunds 6/10 of cost", async () => {
  let current = 1_700_000_000_000;
  const service = makeService({ now: () => current });

  const session = await service.createSession({
    ip: "192.168.2.77",
    minutes: 10,
    txHash: "pay-sig",
    paymentReference: "ref-789",
    paymentSource: "captive-portal",
    paymentExplorerUrl: "https://explorer.solana.com/tx/pay-sig?cluster=devnet",
    listingId: "local-hotspot",
    sessionType: "human",
    buyerWallet: "buyer-wallet",
    source: "captive-portal",
  });

  // 10 min × 0.001 SOL/min × 1e9 lamports = 10_000_000 lamports total purchased.
  assert.equal(session.amount_lamports, 10_000_000);

  current += 4 * 60 * 1000;

  const result = await service.disconnectSessionByIp(session.ip);
  assert.equal(result.minutes_used, 4);
  assert.equal(result.minutes_remaining, 6);
  assert.equal(result.refund_lamports, 6_000_000);
  assert.equal(result.refund_amount, 0.006);
  assert.equal(result.refund_status, "sent");
  assert.equal(result.session.refund.amountLamports, 6_000_000);
  assert.equal(result.session.refund.amountSol, 0.006);
});

test("expireSessions sweep marks sessions terminated when paid_until < now", async () => {
  let current = 1_700_000_000_000;
  const service = makeService({ now: () => current });

  const session = await service.createSession({
    ip: "192.168.2.81",
    minutes: 5,
    txHash: "pay-sig-expire",
    paymentReference: "ref-expire",
    paymentSource: "captive-portal",
    paymentExplorerUrl: "https://explorer.solana.com/tx/pay-sig-expire?cluster=devnet",
    listingId: "local-hotspot",
    sessionType: "human",
    buyerWallet: "buyer-wallet",
    source: "captive-portal",
  });
  assert.equal(session.status, "active");

  // Sweep before expiry — nothing changes.
  current += 4 * 60 * 1000;
  await service.expireSessions();
  let listed = service.listSessions().find((s) => s.session_id === session.session_id);
  assert.equal(listed.status, "active");

  // Cross paid_until (5 min) — sweep marks expired.
  current += 2 * 60 * 1000;
  await service.expireSessions();
  listed = service.listSessions().find((s) => s.session_id === session.session_id);
  assert.equal(listed.status, "expired");
  assert.equal(listed.minutes_used, 5);
  assert.ok(listed.ended_at, "ended_at should be set after expiry");
  assert.ok(
    listed.status_transitions.some((t) => t.status === "expired"),
    "transition log should include 'expired'"
  );
});

test("listing artifacts include reputation score that updates after sessions complete", async () => {
  let current = 1_700_000_000_000;
  const service = makeService({ now: () => current });

  // Three completed runs: 2 clean, 1 refunded.
  for (let i = 0; i < 2; i++) {
    const session = await service.createSession({
      ip: `192.168.3.${i + 1}`,
      minutes: 5,
      txHash: `clean-${i}`,
      paymentReference: `ref-clean-${i}`,
      paymentSource: "captive-portal",
      paymentExplorerUrl: null,
      listingId: "local-hotspot",
      sessionType: "human",
      buyerWallet: "buyer-wallet",
      source: "captive-portal",
    });
    current += 5 * 60 * 1000 + 1; // push past paid_until
    await service.expireSessions();
    void session;
  }

  // Refunded session — disconnect early.
  const refundSession = await service.createSession({
    ip: "192.168.3.99",
    minutes: 10,
    txHash: "refund-pay",
    paymentReference: "ref-refund-pay",
    paymentSource: "captive-portal",
    paymentExplorerUrl: null,
    listingId: "local-hotspot",
    sessionType: "human",
    buyerWallet: "buyer-wallet",
    source: "captive-portal",
  });
  current += 2 * 60 * 1000;
  const closeout = await service.disconnectSessionByIp(refundSession.ip);
  assert.equal(closeout.session.status, "refunded");

  const listings = service.listListings();
  const local = listings.find((l) => l.id === "local-hotspot");
  assert.ok(local, "local-hotspot listing must exist");
  assert.ok(local.reputation, "listing must carry a reputation block");
  // 3 completed runs, 1 refund → score = 100 - round(33%) = 67.
  assert.equal(local.reputation.successfulSessions, 2);
  assert.equal(local.reputation.refunds, 1);
  assert.equal(local.reputation.reliabilityScore, 67);
  assert.ok(
    Math.abs(local.reputation.disconnectRate - 1 / 3) < 1e-9,
    "disconnectRate should reflect 1 refund out of 3 completed sessions"
  );
  assert.ok(
    local.filecoin?.latestReputationCid,
    "listing should have refreshed CID-backed reputation artifact"
  );
});
