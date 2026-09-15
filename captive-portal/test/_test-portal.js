"use strict";

// Test harness for the captive-portal HTTP/DNS surface. Mirrors the
// security-critical bits of server.js so tests can drive them without
// triggering the top-level listen()/dns2.createServer() side effects.
//
// Each helper notes the matching production location at server.js:LINE.
// If you change a production behavior, mirror it here too — and update
// the assertions in test/server.test.js if the contract shifts.

const express = require("express");
const cors = require("cors");
const { randomBytes, timingSafeEqual } = require("crypto");

// MIRRORS captive-portal/server.js: IPV4_OCTET_RE / IPV4_RE / isValidClientIP
const IPV4_OCTET_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV4_RE = new RegExp(
  `^${IPV4_OCTET_RE.source.slice(1, -1)}(?:\\.${IPV4_OCTET_RE.source.slice(1, -1)}){3}$`
);
function isValidClientIP(ip) {
  return typeof ip === "string" && IPV4_RE.test(ip);
}

// MIRRORS captive-portal/server.js: pfctlExec + pfAdd + pfRemove
function makePfHelpers({ execFileSpy }) {
  function pfctlExec(args) {
    return new Promise((resolve, reject) => {
      execFileSpy("sudo", ["pfctl", ...args], (err, _stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || "pfctl failed").trim()));
        else resolve();
      });
    });
  }
  async function pfAdd(ip) {
    if (!isValidClientIP(ip)) {
      console.error(`[pf] WARN: refusing to add invalid IP ${JSON.stringify(ip)}`);
      return;
    }
    const ops = [
      ["-a", "hotspotdex", "-t", "allowed_clients", "-T", "add", ip],
      ["-a", "hotspotdex-nat", "-t", "paid_bypass", "-T", "add", ip],
    ];
    for (const args of ops) {
      try { await pfctlExec(args); } catch { /* tolerate; mirrors production */ }
    }
  }
  async function pfRemove(ip) {
    if (!isValidClientIP(ip)) return;
    const ops = [
      ["-a", "hotspotdex", "-t", "allowed_clients", "-T", "delete", ip],
      ["-a", "hotspotdex-nat", "-t", "paid_bypass", "-T", "delete", ip],
    ];
    for (const args of ops) {
      try { await pfctlExec(args); } catch { /* tolerate */ }
    }
  }
  return { pfAdd, pfRemove, pfctlExec, isValidClientIP };
}

// MIRRORS captive-portal/server.js: generateCsrfToken + safeTokenEqual
function generateCsrfToken() {
  return randomBytes(32).toString("base64url");
}
function safeTokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// MIRRORS captive-portal/server.js DNS handler logic.
// Unpaid clients get PORTAL_IP for every A record; AAAA → NXDOMAIN.
// Paid clients get real upstream A records (handled by callers in test).
function makeDnsHandler({ portalIp, paidIps = new Set(), allowlist = new Set(), resolve4 }) {
  return function handle({ request, clientIP, send, mockPacketTypes = { A: 1, AAAA: 28, IN: 1 } }) {
    const A = mockPacketTypes.A;
    const AAAA = mockPacketTypes.AAAA;
    const IN = mockPacketTypes.IN;
    const response = {
      header: { rcode: 0 },
      answers: [],
    };

    if (paidIps.has(clientIP)) {
      const question = request.questions[0];
      if (question && question.type === A) {
        return new Promise((resolve) => {
          resolve4(question.name, (err, addresses) => {
            if (!err && addresses?.length) {
              for (const addr of addresses) {
                response.answers.push({
                  name: question.name,
                  type: A,
                  class: IN,
                  ttl: 60,
                  address: addr,
                });
              }
            }
            send(response);
            resolve();
          });
        });
      }
    }

    for (const question of request.questions) {
      if (question.type === AAAA) {
        response.header.rcode = 3; // NXDOMAIN
      } else if (question.type === A) {
        const hostname = String(question.name || "").replace(/\.$/, "").toLowerCase();
        let allowed = false;
        for (const allow of allowlist) {
          if (hostname === allow || hostname.endsWith(`.${allow}`)) {
            allowed = true;
            break;
          }
        }
        if (allowed && resolve4) {
          // simplified: assume real DNS hit; tests don't need this branch
        }
        response.answers.push({
          name: question.name,
          type: A,
          class: IN,
          ttl: 10,
          address: portalIp,
        });
      }
    }
    send(response);
    return Promise.resolve();
  };
}

// Build a mini express app that mirrors the parts of server.js the tests
// need to exercise: GET /payment-request, POST /payment-finalize.
function buildPortalApp({
  pendingPayments,
  fetchImpl,
  controlApi = "http://localhost:3001",
  solanaWallet = "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
  hotspotConfig = { listingId: "local-hotspot" },
  portalIp = "192.168.2.1",
  isSameOriginRequest = () => true, // tests bypass unless they explicitly pass an Origin
} = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "32kb" }));

  app.get("/payment-request", async (req, res) => {
    if (!solanaWallet) {
      return res.status(503).json({ error: "Solana wallet not configured" });
    }
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .split(",")[0]
      .trim()
      .replace(/^::ffff:/, "") || "127.0.0.1";
    const minutes = parseInt(req.query.minutes, 10) || 10;
    const listingId = req.query.listingId || hotspotConfig.listingId;

    try {
      const challengeRes = await fetchImpl(`${controlApi}/x402/sessions/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, listingId, minutes, tier: "standard" }),
      });
      const challenge = await challengeRes.json();
      if (challengeRes.status !== 402) {
        throw new Error(challenge.error || `Unexpected status ${challengeRes.status}`);
      }
      const accept = challenge.accepts?.[0];
      if (!accept) throw new Error("x402 challenge missing payment terms");

      const ref = accept.extra.reference;
      const csrfToken = generateCsrfToken();
      pendingPayments.set(ref, {
        ip,
        minutes,
        listingId,
        payTo: accept.payTo,
        amountLamports: Number(accept.amount || 0),
        memo: accept.memo,
        description: accept.description,
        csrfToken,
        created_at: Date.now(),
        activated: false,
      });

      res.json({
        reference: ref,
        amount: Number(accept.amount || 0) / 1e9,
        minutes,
        listingId,
        csrfToken,
        url: `solana:${accept.payTo}?reference=${ref}`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/payment-finalize", async (req, res) => {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    const reference = String(req.body?.reference || "");
    const signature = String(req.body?.signature || "");
    const csrfToken = String(req.body?.csrfToken || "");

    if (!reference || !signature) {
      return res.status(400).json({ error: "reference and signature are required" });
    }
    if (!csrfToken) {
      return res.status(403).json({ error: "csrfToken required" });
    }
    const pending = pendingPayments.get(reference);
    if (!pending) {
      return res.status(404).json({ error: "unknown or expired reference" });
    }
    if (!safeTokenEqual(pending.csrfToken, csrfToken)) {
      return res.status(403).json({ error: "csrfToken invalid" });
    }
    pending.activated = true;
    pending.signature = signature;
    res.json({ paid: true, tx_hash: signature });
  });

  return app;
}

async function startApp(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

module.exports = {
  IPV4_OCTET_RE,
  IPV4_RE,
  isValidClientIP,
  makePfHelpers,
  generateCsrfToken,
  safeTokenEqual,
  makeDnsHandler,
  buildPortalApp,
  startApp,
};
