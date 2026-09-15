"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHotspotService } = require("../lib/hotspot-service");
const { startTestServer } = require("./_test-app");

const HOST_WALLET = "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-server-"));
}

function makeService({ now, verifyPayment, sendRefund } = {}) {
  return createHotspotService({
    dataDir: mkTmpDir(),
    localIp: "192.168.2.1",
    hostWallet: HOST_WALLET,
    verifyPayment:
      verifyPayment ||
      (async ({ signature, reference }) => ({
        signature,
        buyerWallet: "buyer-wallet",
        explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        reference,
      })),
    sendRefund:
      sendRefund ||
      (async ({ amountLamports }) => ({
        status: amountLamports > 0 ? "sent" : "not_needed",
        signature: amountLamports > 0 ? "refund-sig" : null,
        explorerUrl: amountLamports > 0
          ? "https://explorer.solana.com/tx/refund-sig?cluster=devnet"
          : null,
        sourceWallet: amountLamports > 0 ? "refund-wallet" : null,
      })),
    now,
  });
}

async function bootHarness(options = {}) {
  const { rateLimit, ...serviceOptions } = options;
  const service = makeService(serviceOptions);
  const harness = await startTestServer({ service, rateLimit });
  return { ...harness, service };
}

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test("POST /sessions creates a session and the IP shows up in GET /sessions", async (t) => {
  const harness = await bootHarness();
  t.after(() => harness.close());

  const created = await jsonFetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      ip: "192.168.2.42",
      minutes_purchased: 10,
      tx_hash: "captive-tx",
      buyer_wallet: "buyer-wallet",
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.session.ip, "192.168.2.42");
  assert.equal(created.body.session.minutes_purchased, 10);
  assert.equal(created.body.seconds_granted, 600);

  const listed = await jsonFetch(`${harness.baseUrl}/sessions`);
  assert.equal(listed.status, 200);
  const matched = listed.body.find((s) => s.ip === "192.168.2.42");
  assert.ok(matched, "session created via POST should appear in GET /sessions");
  assert.equal(matched.active, true);
  assert.ok(matched.seconds_remaining > 0);
});

test("DELETE /sessions/:ip computes prorated refund correctly", async (t) => {
  // Lock time so we can simulate disconnecting at exactly the 4-minute mark.
  let current = 1_700_000_000_000;
  const harness = await bootHarness({ now: () => current });
  t.after(() => harness.close());

  await jsonFetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      ip: "192.168.2.99",
      minutes_purchased: 10,
      tx_hash: "captive-tx",
      buyer_wallet: "buyer-wallet",
    }),
  });

  // Advance 4 of 10 minutes — 60% refund expected.
  current += 4 * 60 * 1000;

  const closeout = await jsonFetch(`${harness.baseUrl}/sessions/192.168.2.99`, {
    method: "DELETE",
  });
  assert.equal(closeout.status, 200);
  assert.equal(closeout.body.minutes_used, 4);
  assert.equal(closeout.body.minutes_remaining, 6);

  // Default rate 0.001 SOL/min × 10 minutes × 1e9 = 10_000_000 lamports purchased.
  // 6/10 of that should be refunded.
  assert.equal(closeout.body.refund_lamports, 6_000_000);
  // refund_amount is in SOL, formatted by Number division.
  assert.equal(closeout.body.refund_amount, 0.006);
  assert.equal(closeout.body.refund_status, "sent");
  assert.equal(closeout.body.session.status, "refunded");
});

test("POST /x402/sessions/purchase returns 402 first call, 201 with valid signature on retry", async (t) => {
  const harness = await bootHarness();
  t.after(() => harness.close());

  const challenge = await jsonFetch(`${harness.baseUrl}/x402/sessions/purchase`, {
    method: "POST",
    body: JSON.stringify({
      ip: "10.0.0.22",
      minutes: 5,
      listingId: "local-hotspot",
      buyerWallet: "agent-buyer",
      tier: "priority",
    }),
  });
  assert.equal(challenge.status, 402);
  assert.equal(challenge.body.error, "payment_required");
  const accept = challenge.body.accepts[0];
  assert.equal(accept.network, "solana-devnet");
  assert.ok(accept.extra.reference);
  assert.equal(accept.extra.minutes, 5);

  const reference = accept.extra.reference;

  const fulfilled = await jsonFetch(`${harness.baseUrl}/x402/sessions/purchase`, {
    method: "POST",
    headers: { "Payment-Signature": "agent-sig-001" },
    body: JSON.stringify({
      ip: "10.0.0.22",
      minutes: 5,
      listingId: "local-hotspot",
      buyerWallet: "agent-buyer",
      reference,
    }),
  });
  assert.equal(fulfilled.status, 201);
  assert.equal(fulfilled.body.ok, true);
  assert.equal(fulfilled.body.session.session_type, "agent");
  assert.equal(fulfilled.body.session.tx_hash, "agent-sig-001");
  assert.equal(fulfilled.body.seconds_granted, 300);
});

test("Concurrent extends keep minutes_purchased consistent", async (t) => {
  // Concurrent extends fire ~12 rate-limited requests from one client IP, well
  // over the production capacity of 10/min. Bump the bucket here so the test
  // exercises createSession's withSessionLock under contention rather than the
  // rate limiter (which has its own dedicated test).
  const harness = await bootHarness({ rateLimit: { capacity: 100 } });
  t.after(() => harness.close());

  // Seed an agent session via x402 so we have a sessionId to extend.
  const challenge = await jsonFetch(`${harness.baseUrl}/x402/sessions/purchase`, {
    method: "POST",
    body: JSON.stringify({
      ip: "10.0.0.55",
      minutes: 10,
      listingId: "local-hotspot",
      buyerWallet: "agent-buyer",
    }),
  });
  const seedRef = challenge.body.accepts[0].extra.reference;
  const seeded = await jsonFetch(`${harness.baseUrl}/x402/sessions/purchase`, {
    method: "POST",
    headers: { "Payment-Signature": "seed-sig" },
    body: JSON.stringify({
      ip: "10.0.0.55",
      minutes: 10,
      listingId: "local-hotspot",
      buyerWallet: "agent-buyer",
      reference: seedRef,
    }),
  });
  assert.equal(seeded.status, 201);
  const sessionId = seeded.body.session.session_id;

  // Spawn 5 parallel extends, each adding 3 minutes.
  const PER_EXTEND = 3;
  const PARALLEL = 5;
  const extendOnce = async (i) => {
    const ch = await jsonFetch(`${harness.baseUrl}/x402/sessions/${sessionId}/extend`, {
      method: "POST",
      body: JSON.stringify({ minutes: PER_EXTEND, buyerWallet: "agent-buyer" }),
    });
    assert.equal(ch.status, 402);
    const ref = ch.body.accepts[0].extra.reference;
    const fulfilled = await jsonFetch(
      `${harness.baseUrl}/x402/sessions/${sessionId}/extend`,
      {
        method: "POST",
        headers: { "Payment-Signature": `extend-sig-${i}` },
        body: JSON.stringify({
          minutes: PER_EXTEND,
          buyerWallet: "agent-buyer",
          reference: ref,
        }),
      }
    );
    assert.equal(fulfilled.status, 201);
  };

  await Promise.all(Array.from({ length: PARALLEL }, (_, i) => extendOnce(i)));

  const sessions = await jsonFetch(`${harness.baseUrl}/sessions`);
  const session = sessions.body.find((s) => s.session_id === sessionId);
  assert.ok(session, "seeded session must still exist after extends");
  assert.equal(session.minutes_purchased, 10 + PER_EXTEND * PARALLEL);
});

test("GET /dashboard aggregates correctly with multiple sessions", async (t) => {
  const harness = await bootHarness();
  t.after(() => harness.close());

  for (let i = 0; i < 3; i++) {
    const res = await jsonFetch(`${harness.baseUrl}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        ip: `192.168.2.${10 + i}`,
        minutes_purchased: 5,
        tx_hash: `tx-${i}`,
        buyer_wallet: "buyer-wallet",
      }),
    });
    assert.equal(res.status, 201);
  }

  const dashboard = await jsonFetch(`${harness.baseUrl}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.summary.activeSessions, 3);
  assert.equal(dashboard.body.summary.completedSessions, 0);
  assert.equal(dashboard.body.summary.refunds, 0);
  // 3 sessions × 5 min × 0.001 SOL/min = 0.015 SOL earned.
  assert.ok(Math.abs(dashboard.body.summary.totalEarnedSol - 0.015) < 1e-9);
  assert.ok(Array.isArray(dashboard.body.recentArtifacts));
  assert.ok(dashboard.body.recentArtifacts.length > 0);
});

test("rate limiting kicks in after the bucket capacity is exhausted (10 reqs/min)", async (t) => {
  const harness = await bootHarness();
  t.after(() => harness.close());

  // Burn through the bucket via the rate-limited DELETE path. The first 10
  // tokens succeed (with 404 because no session exists for these IPs); the
  // 11th must come back as 429.
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${harness.baseUrl}/sessions/192.168.99.1`, { method: "DELETE" });
    statuses.push(res.status);
    // Read the body so the connection releases cleanly.
    await res.text();
  }
  // First 10 succeed-or-404 (rate limiter passes them through).
  for (let i = 0; i < 10; i++) {
    assert.notEqual(statuses[i], 429, `request ${i} should not be rate-limited yet`);
  }
  assert.equal(statuses[10], 429, "the 11th request from one IP must be rate-limited");
});
