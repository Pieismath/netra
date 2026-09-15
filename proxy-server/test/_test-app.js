"use strict";

// Test harness: mirrors the express control-API routes from server.js so
// integration tests can boot the same surface area on an ephemeral port
// without modifying production code.  Routes are kept in lock-step with
// server.js — if you change one, mirror it here too.

const express = require("express");
const cors = require("cors");

const DEFAULT_RATE_LIMIT_CAPACITY = 10;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function makeRateLimitMiddleware({
  capacity = DEFAULT_RATE_LIMIT_CAPACITY,
  windowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
} = {}) {
  const refillPerMs = capacity / windowMs;
  const buckets = new Map();
  return function rateLimitByIp(req, res, next) {
    const raw = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    const ip = String(raw).split(",")[0].trim().replace(/^::ffff:/, "");
    const nowMs = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: nowMs };
      buckets.set(ip, bucket);
    } else {
      const elapsed = nowMs - bucket.updatedAt;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = nowMs;
    }
    if (bucket.tokens < 1) {
      const retryMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
      const retrySeconds = Math.max(1, Math.ceil(retryMs / 1000));
      res.set("Retry-After", String(retrySeconds));
      return res.status(429).json({ error: "rate_limited", retry_after_seconds: retrySeconds });
    }
    bucket.tokens -= 1;
    return next();
  };
}

function attachControlRoutes(app, service, { rateLimit } = {}) {
  app.use(cors());
  app.use(express.json({ limit: "32kb" }));
  const rateLimitByIp = makeRateLimitMiddleware(rateLimit || {});
  app.locals.rateLimitByIp = rateLimitByIp;

  app.get("/myip", (req, res) => {
    const raw = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    res.json({ ip: String(raw).split(",")[0].trim().replace(/^::ffff:/, "") });
  });

  app.get("/health", (_req, res) => res.json(service.getHealth()));
  app.get("/dashboard", (_req, res) => res.json(service.getDashboard()));
  app.get("/sessions", (_req, res) => res.json(service.listSessions()));

  app.post("/sessions", rateLimitByIp, async (req, res) => {
    const { ip, minutes_purchased, tx_hash, reference, listing_id, buyer_wallet } = req.body || {};
    if (!ip || !minutes_purchased) {
      return res.status(400).json({ error: "ip and minutes_purchased are required" });
    }
    try {
      const session = await service.createSession({
        ip,
        minutes: Number(minutes_purchased),
        txHash: tx_hash || null,
        paymentReference: reference || null,
        paymentSource: "captive-portal",
        paymentExplorerUrl: tx_hash ? `https://explorer.solana.com/tx/${tx_hash}?cluster=devnet` : null,
        listingId: listing_id,
        sessionType: "human",
        buyerWallet: buyer_wallet || null,
        source: "captive-portal",
      });
      res.status(201).json({
        message: "Session activated",
        session,
        seconds_granted: Number(minutes_purchased) * 60,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/sessions/:ip", rateLimitByIp, async (req, res) => {
    const result = await service.disconnectSessionByIp(req.params.ip);
    if (!result) return res.status(404).json({ error: `Session not found for IP: ${req.params.ip}` });
    res.json(result);
  });

  app.get("/listings", (_req, res) => res.json(service.listListings()));

  app.post("/listings", async (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.pricePerMinute) {
      return res.status(400).json({ error: "name and pricePerMinute are required" });
    }
    try {
      const listing = await service.upsertListing(body);
      res.status(201).json(listing);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/listings/:id", (req, res) => {
    const ok = service.removeListing(req.params.id);
    if (!ok) return res.status(404).json({ error: "Listing not found" });
    res.json({ ok: true });
  });

  app.post("/x402/sessions/purchase", rateLimitByIp, async (req, res) => {
    const paymentSignature = req.get("Payment-Signature");
    const { ip, minutes, listingId, buyerWallet, tier, reference } = req.body || {};
    if (!ip || !minutes) {
      return res.status(400).json({ error: "ip and minutes are required" });
    }
    if (!paymentSignature) {
      try {
        const intent = service.buildIntent({ ip, minutes, listingId, buyerWallet, tier, action: "purchase" });
        return res.status(402).json(
          service.buildX402Challenge(intent, "/x402/sessions/purchase", "Buy hotspot access programmatically with Solana.")
        );
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    try {
      const result = await service.fulfillIntent({ reference, signature: paymentSignature, buyerWallet });
      res.status(201).json({
        ok: true,
        payment: result.payment,
        session: result.session,
        seconds_granted: Number(result.session.minutes_purchased || minutes) * 60,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/x402/sessions/:sessionId/extend", rateLimitByIp, async (req, res) => {
    const paymentSignature = req.get("Payment-Signature");
    const { minutes, buyerWallet, tier, reference } = req.body || {};
    const { sessionId } = req.params;
    const session = service.listSessions().find((item) => item.session_id === sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (!paymentSignature) {
      try {
        const intent = service.buildIntent({
          ip: session.ip,
          minutes,
          listingId: session.listing_id,
          buyerWallet,
          tier,
          action: "extend",
          sessionId,
        });
        return res.status(402).json(
          service.buildX402Challenge(intent, `/x402/sessions/${sessionId}/extend`, "Extend hotspot access for an active agent session.")
        );
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    try {
      const result = await service.fulfillIntent({ reference, signature: paymentSignature, buyerWallet });
      res.status(201).json({
        ok: true,
        payment: result.payment,
        session: result.session,
        seconds_granted: Number(result.session.minutes_purchased || minutes) * 60,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/x402/spec", (_req, res) => {
    res.json({
      resource: "/x402/sessions/purchase",
      method: "POST",
      network: "solana-devnet",
      retryHeader: "Payment-Signature",
    });
  });

  return app;
}

async function startTestServer({ service, rateLimit } = {}) {
  const app = express();
  attachControlRoutes(app, service, { rateLimit });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

module.exports = { attachControlRoutes, startTestServer };
