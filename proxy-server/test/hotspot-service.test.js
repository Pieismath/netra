"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHotspotService } = require("../lib/hotspot-service");

test("creates CID-backed session artifacts and dashboard stats", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-service-"));
  const service = createHotspotService({
    dataDir: tmp,
    localIp: "192.168.2.1",
    hostWallet: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
    verifyPayment: async () => ({
      signature: "test-sig",
      buyerWallet: "buyer-wallet",
      explorerUrl: "https://explorer.solana.com/tx/test-sig?cluster=devnet",
    }),
    now: (() => {
      let current = 1_700_000_000_000;
      return () => current;
    })(),
  });

  const session = await service.createSession({
    ip: "192.168.2.88",
    minutes: 10,
    txHash: "test-sig",
    paymentReference: "ref-123",
    paymentSource: "captive-portal",
    paymentExplorerUrl: "https://explorer.solana.com/tx/test-sig?cluster=devnet",
    listingId: "local-hotspot",
    sessionType: "human",
    buyerWallet: "buyer-wallet",
    source: "captive-portal",
  });

  assert.equal(session.status, "active");
  assert.ok(session.filecoin.latestCid);
  assert.ok(fs.existsSync(path.join(tmp, "artifacts", `${session.filecoin.latestCid}.json`)));

  const dashboard = service.getDashboard();
  assert.equal(dashboard.summary.activeSessions, 1);
  assert.equal(dashboard.recentArtifacts.length > 0, true);
});

test("returns a 402-style challenge and fulfills agent purchases", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-service-"));
  const service = createHotspotService({
    dataDir: tmp,
    localIp: "192.168.2.1",
    hostWallet: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
    verifyPayment: async ({ signature, reference }) => ({
      signature,
      buyerWallet: "buyer-wallet",
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      reference,
    }),
  });

  const intent = service.buildIntent({
    ip: "10.0.0.22",
    minutes: 5,
    listingId: "local-hotspot",
    buyerWallet: "buyer-wallet",
    tier: "priority",
    action: "purchase",
  });
  const challenge = service.buildX402Challenge(intent, "/x402/sessions/purchase", "Agent hotspot access");

  assert.equal(challenge.error, "payment_required");
  assert.equal(challenge.accepts[0].network, "solana-devnet");

  const result = await service.fulfillIntent({
    reference: intent.reference,
    signature: "agent-sig",
    buyerWallet: "buyer-wallet",
  });

  assert.equal(result.session.session_type, "agent");
  assert.equal(result.session.tx_hash, "agent-sig");
});

test("disconnecting early refunds the unused prorated amount", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-service-"));
  let current = 1_700_000_000_000;
  const service = createHotspotService({
    dataDir: tmp,
    localIp: "192.168.2.1",
    hostWallet: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
    now: () => current,
    sendRefund: async ({ destination, amountLamports }) => {
      assert.equal(destination, "buyer-wallet");
      return {
        status: "sent",
        signature: "refund-sig",
        explorerUrl: "https://explorer.solana.com/tx/refund-sig?cluster=devnet",
        sourceWallet: "refund-wallet",
      };
    },
  });

  const session = await service.createSession({
    ip: "192.168.2.55",
    minutes: 10,
    txHash: "pay-sig",
    paymentReference: "ref-456",
    paymentSource: "captive-portal",
    paymentExplorerUrl: "https://explorer.solana.com/tx/pay-sig?cluster=devnet",
    listingId: "local-hotspot",
    sessionType: "human",
    buyerWallet: "buyer-wallet",
    source: "captive-portal",
  });

  current += 2.5 * 60 * 1000;
  const result = await service.disconnectSessionByIp(session.ip);

  assert.equal(result.minutes_used, 2.5);
  assert.equal(result.minutes_remaining, 7.5);
  assert.equal(result.refund_amount, 0.0075);
  assert.equal(result.refund_status, "sent");
  assert.equal(result.refund_tx_hash, "refund-sig");
  assert.equal(result.session.status, "refunded");
  assert.equal(result.session.refund.txHash, "refund-sig");
});

test("fulfillIntent is idempotent for the same (reference, signature) pair", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-service-"));
  let verifyCount = 0;
  const service = createHotspotService({
    dataDir: tmp,
    localIp: "192.168.2.1",
    hostWallet: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
    verifyPayment: async ({ signature }) => {
      verifyCount += 1;
      return {
        signature,
        buyerWallet: "buyer-wallet",
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      };
    },
  });

  const intent = service.buildIntent({
    ip: "10.0.0.99",
    minutes: 5,
    listingId: "local-hotspot",
    buyerWallet: "buyer-wallet",
    tier: "standard",
    action: "purchase",
  });

  const first = await service.fulfillIntent({
    reference: intent.reference,
    signature: "agent-sig-idem",
    buyerWallet: "buyer-wallet",
  });
  const second = await service.fulfillIntent({
    reference: intent.reference,
    signature: "agent-sig-idem",
    buyerWallet: "buyer-wallet",
  });

  assert.equal(verifyCount, 1);
  assert.equal(first.session.session_id, second.session.session_id);
  assert.equal(service.listSessions().filter((s) => s.ip === "10.0.0.99").length, 1);
  assert.equal(first.session.minutes_purchased, second.session.minutes_purchased);
});

test("concurrent extensions on the same session sum without losing increments", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-service-"));
  const service = createHotspotService({
    dataDir: tmp,
    localIp: "192.168.2.1",
    hostWallet: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
  });

  const initial = await service.createSession({
    ip: "192.168.2.42",
    minutes: 10,
    txHash: "init-sig",
    paymentReference: "ref-init",
    paymentSource: "captive-portal",
    paymentExplorerUrl: null,
    listingId: "local-hotspot",
    sessionType: "human",
    buyerWallet: "buyer-wallet",
    source: "captive-portal",
  });

  const extendOnce = (refSuffix) =>
    service.createSession({
      ip: "192.168.2.42",
      minutes: 5,
      txHash: `ext-${refSuffix}`,
      paymentReference: `ref-${refSuffix}`,
      paymentSource: "captive-portal",
      paymentExplorerUrl: null,
      listingId: "local-hotspot",
      sessionType: "human",
      buyerWallet: "buyer-wallet",
      source: "captive-portal",
    });

  const [a, b] = await Promise.all([extendOnce("a"), extendOnce("b")]);
  assert.equal(a.session_id, initial.session_id);
  assert.equal(b.session_id, initial.session_id);
  assert.equal(a.minutes_purchased, 20);
  assert.equal(b.minutes_purchased, 20);

  const reloaded = service.listSessions().find((s) => s.session_id === initial.session_id);
  assert.equal(reloaded.minutes_purchased, 20);
});

test("refund failures retry, succeed on later attempt, and persist a transition", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-service-"));
  let current = 1_700_000_000_000;
  let refundAttempts = 0;
  const service = createHotspotService({
    dataDir: tmp,
    localIp: "192.168.2.1",
    hostWallet: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
    now: () => current,
    sendRefund: async () => {
      refundAttempts += 1;
      if (refundAttempts < 3) throw new Error("transient network error");
      return {
        status: "sent",
        signature: "retry-sig",
        explorerUrl: "https://explorer.solana.com/tx/retry-sig?cluster=devnet",
        sourceWallet: "refund-wallet",
      };
    },
  });

  const session = await service.createSession({
    ip: "192.168.2.77",
    minutes: 10,
    txHash: "pay-sig",
    paymentReference: "ref-retry",
    paymentSource: "captive-portal",
    paymentExplorerUrl: null,
    listingId: "local-hotspot",
    sessionType: "human",
    buyerWallet: "buyer-wallet",
    source: "captive-portal",
  });

  current += 2.5 * 60 * 1000;
  const result = await service.disconnectSessionByIp(session.ip);
  assert.equal(result.refund_status, "failed");
  assert.equal(refundAttempts, 1);

  current += 60 * 60 * 1000;
  await service.processPendingRefunds();
  assert.equal(refundAttempts, 2);

  current += 60 * 60 * 1000;
  await service.processPendingRefunds();
  assert.equal(refundAttempts, 3);

  const ledger = service.listSessions().find((s) => s.session_id === session.session_id);
  assert.equal(ledger.refund.status, "sent");
  assert.equal(ledger.refund.txHash, "retry-sig");
  const queueEntry = service.listPendingRefunds().find((entry) => entry.sessionId === session.session_id);
  assert.equal(queueEntry.status, "sent");
});

test("refunds are marked permanently_failed after 5 attempts and emit a console error", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-service-"));
  let current = 1_700_000_000_000;
  let refundAttempts = 0;
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const service = createHotspotService({
      dataDir: tmp,
      localIp: "192.168.2.1",
      hostWallet: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
      now: () => current,
      sendRefund: async () => {
        refundAttempts += 1;
        throw new Error("network unreachable");
      },
    });

    const session = await service.createSession({
      ip: "192.168.2.88",
      minutes: 10,
      txHash: "pay-sig",
      paymentReference: "ref-permfail",
      paymentSource: "captive-portal",
      paymentExplorerUrl: null,
      listingId: "local-hotspot",
      sessionType: "human",
      buyerWallet: "buyer-wallet",
      source: "captive-portal",
    });

    current += 2.5 * 60 * 1000;
    await service.disconnectSessionByIp(session.ip);
    assert.equal(refundAttempts, 1);

    for (let i = 0; i < 6; i++) {
      current += 24 * 60 * 60 * 1000;
      await service.processPendingRefunds();
    }

    assert.equal(refundAttempts, 5);
    const ledger = service.listSessions().find((s) => s.session_id === session.session_id);
    assert.equal(ledger.refund.status, "permanently_failed");
    const queueEntry = service.listPendingRefunds().find((entry) => entry.sessionId === session.session_id);
    assert.equal(queueEntry.status, "permanently_failed");
    assert.equal(queueEntry.attempts, 5);
    assert.ok(errors.some((line) => /permanently failed/.test(line)));
  } finally {
    console.error = originalConsoleError;
  }
});
