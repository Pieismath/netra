/**
 * Netra proxy + control plane
 *
 * Ports:
 *   8080 - traffic gateway. Unpaid clients stay blocked.
 *   3001 - host dashboard API, session ledger, x402 payment challenge API.
 */

"use strict";

const http = require("http");
const net = require("net");
const path = require("path");
const { execSync } = require("child_process");

const cors = require("cors");
const express = require("express");
const httpProxy = require("http-proxy");

function parseConnectTarget(rawUrl) {
  // CONNECT URLs look like host:port, ipv4:port, or [ipv6]:port.
  if (!rawUrl) return null;
  if (rawUrl.startsWith("[")) {
    const close = rawUrl.indexOf("]");
    if (close < 0) return null;
    const host = rawUrl.slice(1, close);
    const rest = rawUrl.slice(close + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : 443;
    if (!host || !Number.isFinite(port)) return null;
    return { host, port };
  }
  const lastColon = rawUrl.lastIndexOf(":");
  if (lastColon < 0) return { host: rawUrl, port: 443 };
  const host = rawUrl.slice(0, lastColon);
  const port = Number(rawUrl.slice(lastColon + 1));
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

const { createHotspotService, normalizeIp } = require("./lib/hotspot-service");

const PROXY_PORT = Number(process.env.PROXY_PORT || 8080);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 3001);
const PORTAL_PORT = Number(process.env.PORTAL_PORT || 8888);
const RATE_PER_MINUTE = Number(process.env.RATE_PER_MIN || 0.001);
const TRUST_PROXY = String(process.env.TRUST_PROXY || "false").toLowerCase() === "true";

function ipv4ToInt(ip) {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = result * 256 + n;
  }
  return result >>> 0;
}

function parseCIDR(cidr) {
  const [ip, prefixStr] = String(cidr || "").split("/");
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ipInt & mask) >>> 0, mask };
}

const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS || "127.0.0.1/8")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(parseCIDR)
  .filter(Boolean);

function ipInTrustedProxies(ip) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  return TRUSTED_PROXY_CIDRS.some(({ network, mask }) => ((ipInt & mask) >>> 0) === network);
}

function clientIpFor(req) {
  const remote = normalizeIp(req.socket.remoteAddress || "127.0.0.1");
  if (!TRUST_PROXY || !ipInTrustedProxies(remote)) return remote;
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return remote;
  const leftmost = String(xff).split(",")[0].trim();
  return normalizeIp(leftmost) || remote;
}

function ts() {
  return new Date().toISOString();
}

function getLocalIP() {
  try {
    return execSync("ipconfig getifaddr en0", { encoding: "utf8" }).trim();
  } catch {
    try {
      return execSync("ipconfig getifaddr en1", { encoding: "utf8" }).trim();
    } catch {
      return "localhost";
    }
  }
}

const LOCAL_IP = getLocalIP();
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", LOCAL_IP]);

function isWhitelisted(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return LOCAL_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

function buildBlockedPayload() {
  return {
    error: "payment_required",
    message: "Join the hotspot, then pay in the captive portal before normal internet access unlocks.",
    flow: {
      human: `http://${LOCAL_IP}:${PORTAL_PORT}/`,
      agent: `http://${LOCAL_IP}:${CONTROL_PORT}/x402/sessions/purchase`,
    },
    rate_per_minute_sol: RATE_PER_MINUTE,
    states: ["unpaid", "payment_pending", "paid", "session_active", "session_expired"],
  };
}

const service = createHotspotService({
  dataDir: path.join(__dirname, "data"),
  localIp: LOCAL_IP,
  portalPort: PORTAL_PORT,
});

setInterval(() => {
  service.expireSessions().catch((error) => {
    console.error(`[${ts()}] session expiry sweep failed: ${error.message}`);
  });
}, 15_000);

setInterval(() => {
  service.processPendingRefunds().catch((error) => {
    console.error(`[${ts()}] refund retry sweep failed: ${error.message}`);
  });
}, 30_000);

const proxy = httpProxy.createProxyServer({});
proxy.on("error", (error, _req, res) => {
  console.error(`[${ts()}] PROXY ERROR: ${error.message}`);
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad_gateway", message: error.message }));
  }
});

proxy.on("proxyReq", (proxyReq, req) => {
  proxyReq.setHeader("x-forwarded-for", normalizeIp(req.socket.remoteAddress));
});

proxy.on("proxyRes", (proxyRes, req) => {
  const ip = normalizeIp(req.socket.remoteAddress || "127.0.0.1");
  const len = parseInt(proxyRes.headers["content-length"] || "0", 10);
  service.recordForwardedBytes(ip, len);
});

const proxyServer = http.createServer((req, res) => {
  const ip = clientIpFor(req);
  const url = req.url || "/";
  const activeSession = service.getActiveSessionForIp(ip);

  if (activeSession || isWhitelisted(url)) {
    const tag = activeSession ? "ALLOWED" : "WHITELISTED";
    console.log(`[${ts()}] ${ip} | ${tag} | ${url}`);
    proxy.web(req, res, { target: url, changeOrigin: true });
    return;
  }

  console.log(`[${ts()}] ${ip} | BLOCKED | ${url}`);
  const acceptsHtml = String(req.headers.accept || "").includes("text/html");
  const portalUrl = `http://${LOCAL_IP}:${PORTAL_PORT}/`;

  if (acceptsHtml) {
    res.writeHead(302, {
      Location: portalUrl,
      "Content-Type": "text/html",
    });
    res.end(
      `<html><body>Netra requires payment before internet access. <a href="${portalUrl}">Open the captive portal</a>.</body></html>`
    );
    return;
  }

  res.writeHead(402, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildBlockedPayload()));
});

proxyServer.on("connect", (req, clientSocket, head) => {
  const ip = normalizeIp(clientSocket.remoteAddress || "127.0.0.1");
  const activeSession = service.getActiveSessionForIp(ip);

  if (!activeSession) {
    console.log(`[${ts()}] ${ip} | BLOCKED (CONNECT) | ${req.url}`);
    if (!clientSocket.destroyed) {
      clientSocket.end(
        "HTTP/1.1 403 Forbidden\r\n" +
          `X-Netra-Portal: http://${LOCAL_IP}:${PORTAL_PORT}/\r\n` +
          "Content-Length: 0\r\n\r\n"
      );
    }
    return;
  }

  console.log(`[${ts()}] ${ip} | ALLOWED (CONNECT) | ${req.url}`);
  const target = parseConnectTarget(req.url);
  if (!target) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  const serverSocket = net.connect(target.port, target.host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on("error", (error) => {
    console.error(`[${ts()}] CONNECT upstream error (${target.host}:${target.port}): ${error.message}`);
    if (!clientSocket.destroyed) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    }
  });
  clientSocket.on("error", () => serverSocket.destroy());
});

proxyServer.listen(PROXY_PORT, () => {
  console.log(`[${ts()}] Proxy server listening on :${PROXY_PORT}`);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

const RATE_LIMIT_CAPACITY = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REFILL_PER_MS = RATE_LIMIT_CAPACITY / RATE_LIMIT_WINDOW_MS;
const rateBuckets = new Map();

function rateLimitByIp(req, res, next) {
  const ip = clientIpFor(req);
  const nowMs = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, updatedAt: nowMs };
    rateBuckets.set(ip, bucket);
  } else {
    const elapsed = nowMs - bucket.updatedAt;
    bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + elapsed * RATE_LIMIT_REFILL_PER_MS);
    bucket.updatedAt = nowMs;
  }

  if (bucket.tokens < 1) {
    const retryMs = Math.ceil((1 - bucket.tokens) / RATE_LIMIT_REFILL_PER_MS);
    const retrySeconds = Math.max(1, Math.ceil(retryMs / 1000));
    res.set("Retry-After", String(retrySeconds));
    return res.status(429).json({ error: "rate_limited", retry_after_seconds: retrySeconds });
  }

  bucket.tokens -= 1;
  return next();
}

setInterval(() => {
  const cutoff = Date.now() - 5 * RATE_LIMIT_WINDOW_MS;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.updatedAt < cutoff && bucket.tokens >= RATE_LIMIT_CAPACITY) {
      rateBuckets.delete(key);
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.get("/myip", (req, res) => {
  res.json({ ip: clientIpFor(req) });
});

app.get("/health", (_req, res) => {
  res.json(service.getHealth());
});

app.get("/dashboard", (_req, res) => {
  res.json(service.getDashboard());
});

app.get("/sessions", (_req, res) => {
  res.json(service.listSessions());
});

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
      paymentExplorerUrl: tx_hash
        ? `https://explorer.solana.com/tx/${tx_hash}?cluster=devnet`
        : null,
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
  if (!result) {
    return res.status(404).json({ error: `Session not found for IP: ${req.params.ip}` });
  }
  res.json(result);
});

app.get("/listings", (_req, res) => {
  res.json(service.listListings());
});

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
      const intent = service.buildIntent({
        ip,
        minutes,
        listingId,
        buyerWallet,
        tier,
        action: "purchase",
      });
      return res.status(402).json(
        service.buildX402Challenge(
          intent,
          "/x402/sessions/purchase",
          "Buy hotspot access programmatically with Solana."
        )
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  try {
    const result = await service.fulfillIntent({
      reference,
      signature: paymentSignature,
      buyerWallet,
    });
    res.status(201).json({
      ok: true,
      payment: result.payment,
      session: result.session,
      seconds_granted: Number(result.session.minutes_purchased || minutes) * 60,
      lifecycle: {
        unpaid: false,
        paymentPending: false,
        paid: true,
        sessionActive: true,
      },
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

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

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
        service.buildX402Challenge(
          intent,
          `/x402/sessions/${sessionId}/extend`,
          "Extend hotspot access for an active agent session."
        )
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  try {
    const result = await service.fulfillIntent({
      reference,
      signature: paymentSignature,
      buyerWallet,
    });
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
    description: "Programmatic hotspot purchase via HTTP 402 Payment Required",
    retryHeader: "Payment-Signature",
    exampleScript: "./proxy-server/scripts/x402-demo.js",
  });
});

const controlServer = app.listen(CONTROL_PORT, () => {
  console.log(`[${ts()}] Control API listening on :${CONTROL_PORT}`);
  console.log(`[${ts()}] x402 purchase endpoint: http://${LOCAL_IP}:${CONTROL_PORT}/x402/sessions/purchase`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${ts()}] received ${signal}, shutting down`);

  const closes = [
    new Promise((resolve) => proxyServer.close(() => resolve())),
    new Promise((resolve) => controlServer.close(() => resolve())),
  ];

  const forceExit = setTimeout(() => {
    console.error(`[${ts()}] forced exit — close timeout exceeded`);
    process.exit(1);
  }, 5000);
  forceExit.unref();

  Promise.all(closes).finally(() => {
    try {
      service.close();
    } catch (error) {
      console.error(`[${ts()}] service close error: ${error.message}`);
    }
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
