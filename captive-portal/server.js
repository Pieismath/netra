/**
 * Netra Captive Portal Server
 *
 * Runs two services:
 *   Port 5300 — DNS server (pf redirects :53 → here)
 *               Resolves ALL domains to PORTAL_IP so iOS captive portal
 *               check (captive.apple.com) hits our HTTP server.
 *
 *   Port 8888 — HTTP portal server (pf redirects :80 → here)
 *               • Detects Apple/Android captive-portal probes
 *               • Serves the mobile payment page
 *               • POST /activate  — creates session + opens firewall for IP
 *               • POST /disconnect — closes session + closes firewall for IP
 *
 * Firewall management:
 *   Uses macOS pf with a persistent table <allowed_clients>.
 *   After payment: sudo pfctl -t allowed_clients -T add <ip>
 *   On disconnect:  sudo pfctl -t allowed_clients -T delete <ip>
 *
 * Prerequisites (one-time):
 *   1. Enable Internet Sharing on your Mac (Settings → General → Sharing)
 *   2. Run: sudo ./setup-pf.sh
 * Then:
 *   node server.js  (no sudo needed — pf handles the port redirects)
 */

"use strict";

const express   = require("express");
const cors      = require("cors");
const path      = require("path");
const https     = require("https");
const fs        = require("fs");
const { v4: uuidv4 } = require("uuid");
const { execSync, execFile } = require("child_process");
const { randomBytes, timingSafeEqual } = require("crypto");
const bs58      = require("bs58");
const QRCode    = require("qrcode");
const dns2      = require("dns2");
const { Packet } = dns2;

// ─── Config ───────────────────────────────────────────────────────────────────

const HTTP_PORT  = 8888;   // pf rdr :80  → :8888
const HTTPS_PORT = 8443;   // pf rdr :443 → :8443
const DNS_PORT  = 5300;   // pf rdr :53  → :5300
const CONTROL_API  = process.env.CONTROL_API  ?? "http://localhost:3001";
const RATE_PER_MIN = parseFloat(process.env.RATE_PER_MIN ?? "0.001"); // SOL per minute
const SECURE_PORTAL_ORIGIN = process.env.SECURE_PORTAL_ORIGIN ?? "https://captive.apple.com";
const PHANTOM_BROWSE_ORIGIN = "https://phantom.app";
const EXTRA_PREPAY_ALLOW_HOSTS = String(process.env.EXTRA_PREPAY_ALLOW_HOSTS || "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

let solanaWeb3;
try {
  solanaWeb3 = require("@solana/web3.js");
} catch {
  solanaWeb3 = require(path.join(__dirname, "..", "proxy-server", "node_modules", "@solana", "web3.js"));
}

const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
} = solanaWeb3;

// ─── Demo buyer wallet (server-side auto-pay for demos) ───────────────────────
// Set DEMO_BUYER_PRIVKEY (base58) to enable one-tap payment without opening
// any wallet app.  The server signs + broadcasts the Solana tx automatically.
const DEMO_BUYER_PRIVKEY = process.env.DEMO_BUYER_PRIVKEY ?? null;
let demoBuyerKeypair = null;
if (DEMO_BUYER_PRIVKEY) {
  try {
    demoBuyerKeypair = Keypair.fromSecretKey(bs58.decode(DEMO_BUYER_PRIVKEY));
    console.log(`[Portal] Demo buyer wallet: ${demoBuyerKeypair.publicKey.toBase58()}`);
  } catch {
    // Never log err / err.message — error text from base58 / Keypair can
    // include partial key material.
    console.error("[Portal] DEMO_BUYER_PRIVKEY invalid format");
  }
}

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// ─── Solana config ─────────────────────────────────────────────────────────────
const SOLANA_RPC    = process.env.SOLANA_RPC    ?? "https://api.devnet.solana.com";
const SOLANA_WALLET = process.env.SOLANA_WALLET ?? null; // host's wallet (base58)
const SOLANA_RPC_HOST = (() => {
  try {
    return new URL(SOLANA_RPC).hostname;
  } catch {
    return "api.devnet.solana.com";
  }
})();
const PHANTOM_BROWSE_HOST = (() => {
  try {
    return new URL(PHANTOM_BROWSE_ORIGIN).hostname;
  } catch {
    return "phantom.app";
  }
})();
const SECURE_PORTAL_HOST = (() => {
  try {
    return new URL(SECURE_PORTAL_ORIGIN).hostname;
  } catch {
    return "";
  }
})();
const DNS_ALLOWLIST = new Set([
  SOLANA_RPC_HOST,
  PHANTOM_BROWSE_HOST,
  ...EXTRA_PREPAY_ALLOW_HOSTS,
]);

function isConfiguredSecureCheckoutOrigin() {
  return Boolean(SECURE_PORTAL_ORIGIN) &&
    SECURE_PORTAL_ORIGIN !== "https://captive.apple.com" &&
    SECURE_PORTAL_HOST &&
    !/^(localhost|127\.0\.0\.1)$/i.test(SECURE_PORTAL_HOST);
}

// ─── Hotspot config (set by start.sh or env vars) ────────────────────────────
// These are served to the captive portal page via GET /config
const HOTSPOT_CONFIG = {
  name:            process.env.HOTSPOT_NAME     ?? "WiFi Hotspot",
  ssid:            process.env.HOTSPOT_SSID     ?? "⚡Netra-Hotspot",
  listingId:       process.env.HOTSPOT_LISTING_ID ?? "local-hotspot",
  rate:            RATE_PER_MIN,
  currency:        "SOL",
  downloadMbps:    parseInt(process.env.HOTSPOT_DOWN ?? "100"),
  uploadMbps:      parseInt(process.env.HOTSPOT_UP   ?? "50"),
  signalStrength:  parseInt(process.env.HOTSPOT_SIGNAL ?? "4"),
  location:        process.env.HOTSPOT_LOCATION ?? "",
  walletConfigured: !!SOLANA_WALLET,
};

async function fetchMarketplace() {
  try {
    const res = await fetch(`${CONTROL_API}/listings`);
    if (!res.ok) throw new Error(`listing fetch failed: ${res.status}`);
    const listings = await res.json();
    if (Array.isArray(listings) && listings.length > 0) return listings;
  } catch (err) {
    console.warn("[Portal] Could not load listings from control API:", err.message);
  }

  return [
    {
      id: HOTSPOT_CONFIG.listingId,
      name: HOTSPOT_CONFIG.name,
      ssid: HOTSPOT_CONFIG.ssid,
      location: HOTSPOT_CONFIG.location,
      pricePerMinute: HOTSPOT_CONFIG.rate,
      signalStrength: HOTSPOT_CONFIG.signalStrength,
      status: "available",
      host: "local-host",
      hostIp: PORTAL_IP,
      portalUrl: `http://${PORTAL_IP}:${HTTP_PORT}/`,
      uploadMbps: HOTSPOT_CONFIG.uploadMbps,
      downloadMbps: HOTSPOT_CONFIG.downloadMbps,
      hostWallet: SOLANA_WALLET,
      filecoin: {},
      reputation: { reliabilityScore: 100, successfulSessions: 0, refunds: 0, disconnectRate: 0 },
    },
  ];
}

function challengeToSolanaPayUrl(accept) {
  const amountSol = (Number(accept.amount || 0) / 1e9).toFixed(6);
  const params = new URLSearchParams({
    amount: amountSol,
    label: "Netra",
    message: accept.description || "Hotspot session purchase",
    reference: accept.extra.reference,
    memo: accept.memo || `netra:${accept.extra.reference}`,
  });
  return `solana:${accept.payTo}?${params.toString()}`;
}

function buildCheckoutUrl({ reference, listingId, minutes, payUrl, amountSol }) {
  // Prefer a dedicated trusted HTTPS portal origin when configured. This is the
  // only same-device path that gives Phantom a secure context instead of
  // http://192.168.x.x. Otherwise fall back to the local HTTP portal.
  const base = isConfiguredSecureCheckoutOrigin()
    ? SECURE_PORTAL_ORIGIN
    : `http://${PORTAL_IP}:${HTTP_PORT}`;
  const url = new URL("/checkout", base);
  url.searchParams.set("checkout", "1");
  url.searchParams.set("autopay", "1");
  if (reference) url.searchParams.set("reference", reference);
  if (listingId) url.searchParams.set("listingId", listingId);
  if (minutes) url.searchParams.set("minutes", String(minutes));
  // Include the solana: payment URI so the checkout page can show a
  // tap-to-pay button even when Phantom has not injected its provider.
  if (payUrl) url.searchParams.set("payUrl", payUrl);
  if (amountSol !== undefined && amountSol !== null) {
    url.searchParams.set("amount", String(amountSol));
  }
  return url.toString();
}

function buildPhantomBrowseUrl(checkoutUrl) {
  // ref = local portal origin so Phantom knows where the dApp lives.
  const ref = `http://${PORTAL_IP}:${HTTP_PORT}`;
  return `${PHANTOM_BROWSE_ORIGIN}/ul/browse/${encodeURIComponent(checkoutUrl)}?ref=${encodeURIComponent(ref)}`;
}

function buildPendingSolanaPayUrl(reference, pending) {
  if (!pending) return null;
  if (pending.solanaPayUrl) return pending.solanaPayUrl;
  if (!pending.payTo) return null;

  const amountSol = (Number(pending.amountLamports || 0) / 1e9).toFixed(6);
  const params = new URLSearchParams({
    amount: amountSol,
    label: "Netra",
    message: pending.description || "Buy hotspot access programmatically with Solana.",
    reference,
    memo: pending.memo || `netra:${reference}`,
  });
  return `solana:${pending.payTo}?${params.toString()}`;
}

/** Detect the Mac's IP on the shared bridge (Internet Sharing interface). */
function detectPortalIP() {
  const listed = execSync("ifconfig -l 2>/dev/null", { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .filter((iface) => iface.startsWith("bridge"));
  const ordered = ["bridge100", "bridge101", "bridge0", ...listed];

  let fallbackIp = null;

  for (const iface of ordered) {
    try {
      const out = execSync(`ifconfig ${iface} 2>/dev/null`, { encoding: "utf8" });
      const ip = out.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1];
      const status = out.match(/status: (\w+)/)?.[1];
      if (!ip) continue;

      if (!fallbackIp) fallbackIp = ip;
      if (status === "active") {
        console.log(`[Portal] Detected portal IP ${ip} on ${iface} (${status})`);
        return ip;
      }
    } catch {
      // try next interface
    }
  }

  if (fallbackIp) {
    console.warn(`[Portal] No active bridge detected — falling back to ${fallbackIp}`);
    return fallbackIp;
  }

  console.warn("[Portal] Could not detect bridge IP — defaulting to 192.168.2.1");
  return "192.168.2.1";
}

const PORTAL_IP = process.env.PORTAL_IP ?? detectPortalIP();

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Set of IPs that have an active paid session.
 * Used for DNS forwarding, catch-all redirect, and request logging.
 * Set immediately when payment confirms so DNS and HTTP redirects work right away.
 */
const paidIPs = new Set();

/**
 * Set of IPs whose captive-portal probes should return "Success".
 * Delayed ~8 s after paidIPs so the CNA popup stays open long enough
 * for the user to see the success screen / countdown timer.
 * Only used in the probe endpoint handlers.
 */
const captiveReleasedIPs = new Set();

/**
 * Pending Solana Pay sessions waiting for on-chain confirmation.
 * Key: reference pubkey (base58)
 * Value: { ip, minutes, created_at, activated }
 */
const pendingPayments = new Map();

/**
 * Rate-limit buckets for /payment-status: ip → lastRequestMs.
 * Swept periodically to bound memory.
 */
const statusRateBuckets = new Map();

const portalDebugEvents = [];

/**
 * Active per-IP expiry timers. Extending a session for the same IP must
 * cancel the old timer first — otherwise the original expiry fires and
 * yanks firewall access mid-session.
 */
const sessionTimers = new Map(); // ip → { timer, expiresAt }

function scheduleSessionExpiry(ip, durationMs) {
  const previous = sessionTimers.get(ip);
  if (previous) clearTimeout(previous.timer);

  const expiresAt = Date.now() + durationMs;
  const timer = setTimeout(async () => {
    const current = sessionTimers.get(ip);
    if (!current || current.timer !== timer) return; // superseded
    sessionTimers.delete(ip);
    paidIPs.delete(ip);
    captiveReleasedIPs.delete(ip);
    await pfRemove(ip);
    console.log(`[Portal] Session expired for ${ip}`);
  }, durationMs);

  sessionTimers.set(ip, { timer, expiresAt });
}

function cancelSessionExpiry(ip) {
  const entry = sessionTimers.get(ip);
  if (!entry) return;
  clearTimeout(entry.timer);
  sessionTimers.delete(ip);
}

// ─── Periodic sweep — drop stale pending payments and rate-limit buckets ──────
// pendingPayments and statusRateBuckets are otherwise unbounded; without this
// they'd grow indefinitely as references and client IPs accumulate. sessionTimers
// self-cleans inside the timer callback and on /disconnect.

const PENDING_TTL_MS      = 15 * 60 * 1000;
const RATE_BUCKET_TTL_MS  = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS   = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingPayments) {
    if (now - val.created_at > PENDING_TTL_MS) pendingPayments.delete(key);
  }
  for (const [ip, last] of statusRateBuckets) {
    if (now - last > RATE_BUCKET_TTL_MS) statusRateBuckets.delete(ip);
  }
}, SWEEP_INTERVAL_MS).unref();

// ─── Solana Pay helpers ───────────────────────────────────────────────────────

/** Generate a random 32-byte base58 public key to use as a Solana Pay reference. */
function generateReference() {
  return bs58.encode(randomBytes(32));
}

/**
 * Poll the Solana RPC for a transaction that includes `referenceBase58`
 * as an account.  Throws { name: "FindReferenceError" } if not found yet.
 */
async function findReferenceOnChain(referenceBase58) {
  const res = await fetch(SOLANA_RPC, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "getSignaturesForAddress",
      params:  [referenceBase58, { limit: 1, commitment: "confirmed" }],
    }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(error.message);
  if (!result || result.length === 0) {
    const e = new Error("Reference not found");
    e.name = "FindReferenceError";
    throw e;
  }
  return result[0]; // { signature, slot, err, ... }
}

// ─── Firewall helpers (pfctl) ─────────────────────────────────────────────────
//
// SECURITY: pfctl is invoked via execFile (no shell), and `ip` is passed as a
// separate argv element so shell metacharacters cannot inject extra commands.
// We additionally reject anything that doesn't look like a dotted IPv4 octet
// quad before ever spawning a process.

const IPV4_OCTET_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV4_RE = new RegExp(
  `^${IPV4_OCTET_RE.source.slice(1, -1)}(?:\\.${IPV4_OCTET_RE.source.slice(1, -1)}){3}$`
);

function isValidClientIP(ip) {
  return typeof ip === "string" && IPV4_RE.test(ip);
}

function pfctlExec(args) {
  return new Promise((resolve, reject) => {
    execFile("sudo", ["pfctl", ...args], (err, _stdout, stderr) => {
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
    ["-a", "hotspotdex",     "-t", "allowed_clients", "-T", "add", ip],
    ["-a", "hotspotdex-nat", "-t", "paid_bypass",     "-T", "add", ip],
  ];
  const errors = [];
  for (const args of ops) {
    try { await pfctlExec(args); } catch (err) { errors.push(err.message); }
  }
  if (errors.length) {
    console.error(`[pf] WARN: could not add ${ip} — ${errors.join(" / ")}`);
    // Don't hard-fail; session is still tracked in memory
  } else {
    console.log(`[pf] Opened firewall for ${ip}`);
  }
}

async function pfRemove(ip) {
  if (!isValidClientIP(ip)) {
    console.error(`[pf] WARN: refusing to remove invalid IP ${JSON.stringify(ip)}`);
    return;
  }
  const ops = [
    ["-a", "hotspotdex",     "-t", "allowed_clients", "-T", "delete", ip],
    ["-a", "hotspotdex-nat", "-t", "paid_bypass",     "-T", "delete", ip],
  ];
  const errors = [];
  for (const args of ops) {
    try { await pfctlExec(args); } catch (err) { errors.push(err.message); }
  }
  if (errors.length) {
    console.error(`[pf] WARN: could not remove ${ip} — ${errors.join(" / ")}`);
  } else {
    console.log(`[pf] Closed firewall for ${ip}`);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
// Tighten body limit from the 100kb express default — we only ever take
// short JSON payloads (a base58 reference, a signature, a CSRF token).
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));
const portalIndexPath = path.join(__dirname, "public", "index.html");
const solanaWeb3BrowserPath = path.join(
  __dirname,
  "..",
  "proxy-server",
  "node_modules",
  "@solana",
  "web3.js",
  "lib",
  "index.iife.js"
);

/**
 * Extract real client IP, stripping IPv4-mapped IPv6 prefix (::ffff:).
 */
function clientIP(req) {
  const raw = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  return raw.split(",")[0].trim().replace(/^::ffff:/, "");
}

function redirectToPortal(res) {
  res.redirect(302, `http://${PORTAL_IP}/`);
}

// ── Request logger — helps diagnose which probe URLs devices are hitting ───────
app.use((req, res, next) => {
  const ip   = clientIP(req);
  const paid = paidIPs.has(ip) ? "[PAID]" : "[UNPAID]";
  console.log(`[HTTP] ${paid} ${ip} ${req.method} ${req.headers.host || ""}${req.url} UA:${(req.headers["user-agent"] || "").slice(0, 60)}`);
  next();
});

app.post("/debug-event", (req, res) => {
  const event = {
    ts: new Date().toISOString(),
    ip: clientIP(req),
    stage: String(req.body?.stage || "unknown"),
    path: String(req.body?.path || ""),
    reference: req.body?.reference ? String(req.body.reference) : null,
    detail: req.body?.detail && typeof req.body.detail === "object" ? req.body.detail : {},
  };

  portalDebugEvents.push(event);
  if (portalDebugEvents.length > 250) portalDebugEvents.shift();

  const refLabel = event.reference ? ` ref=${event.reference.slice(0, 8)}…` : "";
  const detailLabel = Object.keys(event.detail).length ? ` ${JSON.stringify(event.detail)}` : "";
  console.log(`[PortalDebug] ${event.ip} ${event.stage}${refLabel}${detailLabel}`);
  res.json({ ok: true });
});

app.get("/debug-events", (_req, res) => {
  res.json({ events: portalDebugEvents.slice(-100) });
});

// ── GET /config — serve hotspot info to the payment page ──────────────────────
app.get("/config", (req, res) => {
  res.json({
    ...HOTSPOT_CONFIG,
    rpcHost: SOLANA_RPC_HOST,
    securePortalOrigin: SECURE_PORTAL_ORIGIN,
    // Tell the portal UI whether server-side auto-pay is available so it can
    // skip the wallet-app launch entirely and call /demo-pay instead.
    demoBuyerReady: Boolean(demoBuyerKeypair),
    demoBuyerAddress: demoBuyerKeypair ? demoBuyerKeypair.publicKey.toBase58() : null,
  });
});

app.get("/marketplace-data", async (_req, res) => {
  const listings = await fetchMarketplace();
  res.json({ listings });
});

app.get("/checkout", (_req, res) => {
  res.sendFile(portalIndexPath);
});

app.get("/vendor/solana-web3.js", (_req, res) => {
  if (!fs.existsSync(solanaWeb3BrowserPath)) {
    return res.status(404).type("text/plain").send("solana web3 bundle not found");
  }
  res.type("application/javascript").sendFile(solanaWeb3BrowserPath);
});

app.get("/wallet-status", (req, res) => {
  res.json({
    walletConfigured: Boolean(SOLANA_WALLET),
    provider: "phantom",
    rpcHost: SOLANA_RPC_HOST,
    connectionMode: "portal-only-rpc-allowlist",
  });
});

app.get("/payment-qr.svg", async (req, res) => {
  const reference = String(req.query.reference || "");
  if (!reference) {
    return res.status(400).type("text/plain").send("reference required");
  }

  const pending = pendingPayments.get(reference);
  if (!pending) {
    return res.status(404).type("text/plain").send("unknown or expired reference");
  }

  const payUrl = buildPendingSolanaPayUrl(reference, pending);
  if (!payUrl) {
    return res.status(404).type("text/plain").send("payment link unavailable");
  }

  try {
    const svg = await QRCode.toString(payUrl, {
      type: "svg",
      margin: 1,
      width: 280,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    });
    res.set("Cache-Control", "no-store");
    res.type("image/svg+xml").send(svg);
  } catch (error) {
    console.error("[Portal] payment-qr error:", error.message);
    res.status(500).type("text/plain").send("could not generate qr");
  }
});

// ── CSRF helpers (for /payment-finalize) ──────────────────────────────────────
//
// /payment-finalize triggers real on-chain verification + firewall changes, so
// it gets two layers of CSRF defence:
//   1. Origin/Referer must point at the portal IP (or a configured trusted
//      origin). Cross-site form posts can't forge these in modern browsers.
//   2. A 32-byte random token issued by GET /payment-request and stored on
//      the pendingPayments entry must be echoed back. Each reference has its
//      own token, so cross-reference replay is impossible.

const PORTAL_ALLOWED_HOSTS = new Set([PORTAL_IP]);
if (SECURE_PORTAL_HOST) PORTAL_ALLOWED_HOSTS.add(SECURE_PORTAL_HOST);

function isSameOriginRequest(req) {
  const header = req.headers.origin || req.headers.referer;
  if (!header) return false;
  let hostname;
  try {
    hostname = new URL(header).hostname;
  } catch {
    return false;
  }
  return PORTAL_ALLOWED_HOSTS.has(hostname);
}

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

// ── GET /payment-request?minutes=N ────────────────────────────────────────────
//
// Creates a Solana Pay transfer-request URL with a unique reference key.
// The portal page calls this, then opens the `solana:` deep-link to Phantom.

app.get("/payment-request", (req, res) => {
  if (!SOLANA_WALLET) {
    return res.status(503).json({
      error: "Solana wallet not configured — set the SOLANA_WALLET env var in start.sh.",
    });
  }

  const ip = clientIP(req);
  const minutes = parseInt(req.query.minutes, 10) || 10;
  const listingId = req.query.listingId || HOTSPOT_CONFIG.listingId;

  fetch(`${CONTROL_API}/x402/sessions/purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ip,
      listingId,
      minutes,
      tier: "standard",
    }),
  })
    .then(async (challengeRes) => {
      const challenge = await challengeRes.json();
      if (challengeRes.status !== 402) {
        throw new Error(challenge.error || `Unexpected status ${challengeRes.status}`);
      }

      const accept = challenge.accepts?.[0];
      if (!accept) throw new Error("x402 challenge missing payment terms");

      const ref = accept.extra.reference;
      const solanaPayUrl = challengeToSolanaPayUrl(accept);
      const csrfToken = generateCsrfToken();
      pendingPayments.set(ref, {
        ip,
        minutes,
        listingId,
        payTo: accept.payTo,
        amountLamports: Number(accept.amount || 0),
        memo: accept.memo || `netra:${ref}`,
        description: accept.description || "Buy hotspot access programmatically with Solana.",
        solanaPayUrl,
        csrfToken,
        created_at: Date.now(),
        activated: false,
      });

      // Eviction is handled by the periodic sweep — no need to walk the map here.

      const checkoutUrl = buildCheckoutUrl({
        reference: ref,
        listingId,
        minutes,
        payUrl: solanaPayUrl,
        amountSol: Number(accept.amount || 0) / 1e9,
      });
      console.log(
        `[Portal] x402 challenge: ${ip} ${minutes}min ${accept.amountDisplay} listing=${listingId} ref=${ref.slice(0, 8)}…`
      );
      res.json({
        url: solanaPayUrl,
        checkoutUrl,
        phantomBrowseUrl: buildPhantomBrowseUrl(checkoutUrl),
        reference: ref,
        amount: Number(accept.amount || 0) / 1e9,
        minutes,
        listingId,
        csrfToken,
        challenge,
      });
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
});

app.get("/payment-transaction", async (req, res) => {
  const reference = String(req.query.reference || "");
  const buyerWallet = String(req.query.buyerWallet || "");
  if (!reference || !buyerWallet) {
    return res.status(400).json({ error: "reference and buyerWallet are required" });
  }

  const pending = pendingPayments.get(reference);
  if (!pending) {
    return res.status(404).json({ error: "unknown or expired reference" });
  }

  try {
    const connection = new Connection(SOLANA_RPC, "confirmed");
    const latest = await connection.getLatestBlockhash("confirmed");
    const buyer = new PublicKey(buyerWallet);
    const destination = new PublicKey(pending.payTo);
    const referenceKey = new PublicKey(reference);

    // Build transfer instruction and attach the reference key to it.
    // Memo V2 requires all accounts in its keys[] to be signers — putting the
    // reference there causes "missing required signature".  The System Program
    // ignores extra read-only keys, and getSignaturesForAddress() still finds
    // the transaction by reference because the key appears in the instruction.
    const transferIx = SystemProgram.transfer({
      fromPubkey: buyer,
      toPubkey: destination,
      lamports: Number(pending.amountLamports || 0),
    });
    transferIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

    const tx = new Transaction();
    tx.feePayer = buyer;
    tx.recentBlockhash = latest.blockhash;
    tx.add(transferIx);
    tx.add(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [], // empty — Memo V2 requires signers; reference lives in transferIx
        data: Buffer.from(pending.memo || `netra:${reference}`),
      })
    );

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    res.json({
      reference,
      serializedTransaction: Buffer.from(serialized).toString("base64"),
      amountSol: Number(pending.amountLamports || 0) / 1e9,
      payTo: pending.payTo,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function fulfillPendingPayment({ reference, signature, buyerWallet }) {
  const pending = pendingPayments.get(reference);
  if (!pending) {
    throw new Error("unknown or expired reference");
  }

  if (pending.activated && pending.sessionData) {
    return pending.sessionData;
  }

  const { ip, minutes, listingId } = pending;
  let lastError = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(`${CONTROL_API}/x402/sessions/purchase`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Payment-Signature": signature,
        },
        body: JSON.stringify({
          ip,
          listingId,
          minutes,
          reference,
          tier: "standard",
          buyerWallet: buyerWallet || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      pending.activated = true;
      pending.signature = signature;
      pending.buyerWallet = buyerWallet || null;
      pending.sessionData = payload;

      await pfAdd(ip);
      paidIPs.add(ip); // immediate — DNS forwarding + catch-all handler work right away

      // Delay the captive-probe "Success" response so the portal success screen
      // stays visible for ~8 s before iOS auto-dismisses the CNA popup.
      // pfAdd + paidIPs already opened DNS and the firewall immediately.
      const CAPTIVE_GRACE_MS = 8000;
      setTimeout(() => captiveReleasedIPs.add(ip), CAPTIVE_GRACE_MS);

      scheduleSessionExpiry(ip, minutes * 60 * 1000 + CAPTIVE_GRACE_MS);

      return payload;
    } catch (error) {
      lastError = error;
      if (/Transaction not found|missing the required x402 payment reference/i.test(error.message)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      break;
    }
  }

  throw lastError || new Error("Could not verify payment");
}

app.post("/payment-finalize", async (req, res) => {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: "cross-origin request rejected" });
  }

  const reference   = String(req.body?.reference || "");
  const signature   = String(req.body?.signature || "");
  const csrfToken   = String(req.body?.csrfToken || "");
  const buyerWallet = req.body?.buyerWallet ? String(req.body.buyerWallet) : null;

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

  try {
    const sessionData = await fulfillPendingPayment({ reference, signature, buyerWallet });
    res.json({
      paid: true,
      session: sessionData.session,
      seconds_granted: sessionData.seconds_granted || 0,
      tx_hash: signature,
      explorer_url:
        sessionData.payment?.explorerUrl ||
        `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  } catch (error) {
    console.error("[Portal] payment-finalize error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /demo-pay — server-side auto-pay for demos ───────────────────────────
//
// Requires DEMO_BUYER_PRIVKEY env var (base58 secret key).
// The server builds the Solana transaction, signs it with the demo keypair,
// and broadcasts it to devnet — a real on-chain tx with no wallet app needed.
// Body: { reference } — must match a pending payment created by /payment-request.

app.post("/demo-pay", async (req, res) => {
  if (!demoBuyerKeypair) {
    return res.status(503).json({
      error: "Demo auto-pay not enabled. Set DEMO_BUYER_PRIVKEY in start.sh.",
    });
  }

  const reference = String(req.body?.reference || "");
  if (!reference) {
    return res.status(400).json({ error: "reference is required" });
  }

  const pending = pendingPayments.get(reference);
  if (!pending) {
    return res.status(404).json({ error: "unknown or expired reference — refresh and try again" });
  }

  if (pending.activated && pending.sessionData) {
    // Already paid (e.g. double-tap). Return the cached session.
    return res.json({
      paid: true,
      session: pending.sessionData.session,
      seconds_granted: pending.sessionData.seconds_granted || pending.minutes * 60,
      tx_hash: pending.signature,
      explorer_url: `https://explorer.solana.com/tx/${pending.signature}?cluster=devnet`,
    });
  }

  try {
    const connection = new Connection(SOLANA_RPC, "confirmed");
    const latest = await connection.getLatestBlockhash("confirmed");
    const buyer = demoBuyerKeypair.publicKey;
    const destination = new PublicKey(pending.payTo);
    const referenceKey = new PublicKey(reference);

    // Reference key goes on the transfer instruction, NOT the memo instruction.
    // Memo V2 requires all listed accounts to sign; referenceKey can't sign.
    const transferIx = SystemProgram.transfer({
      fromPubkey: buyer,
      toPubkey: destination,
      lamports: Number(pending.amountLamports || 0),
    });
    transferIx.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

    const tx = new Transaction();
    tx.feePayer = buyer;
    tx.recentBlockhash = latest.blockhash;
    tx.add(transferIx);
    tx.add(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [], // empty — reference is in transferIx so getSignaturesForAddress works
        data: Buffer.from(pending.memo || `netra:${reference}`),
      })
    );

    tx.sign(demoBuyerKeypair);
    const rawTx = tx.serialize();
    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    console.log(`[Portal] Demo-pay broadcast: sig=${signature.slice(0, 10)}… ref=${reference.slice(0, 8)}…`);

    // Wait up to 30s for confirmation then fulfil the session
    await connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );

    const sessionData = await fulfillPendingPayment({
      reference,
      signature,
      buyerWallet: buyer.toBase58(),
    });

    console.log(`[Portal] Demo-pay confirmed: ip=${pending.ip} sig=${signature.slice(0, 10)}…`);
    res.json({
      paid: true,
      session: sessionData.session,
      seconds_granted: sessionData.seconds_granted || pending.minutes * 60,
      tx_hash: signature,
      explorer_url: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  } catch (err) {
    console.error("[Portal] demo-pay error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /payment-status?reference=<base58> ────────────────────────────────────
//
// Portal page polls this after the user approves in Phantom.
// On first confirmed hit: opens the firewall, registers the proxy session.
//
// Rate-limited to 1 request per IP per 2s so a misbehaving (or hostile) client
// can't hammer the Solana RPC through us. The bucket map is bounded by the
// periodic sweep above.

const STATUS_RATE_LIMIT_MS = 2000;

function rateLimitStatus(req, res, next) {
  const ip = clientIP(req);
  const now = Date.now();
  const last = statusRateBuckets.get(ip) || 0;
  if (now - last < STATUS_RATE_LIMIT_MS) {
    res.set("Retry-After", "2");
    return res.status(429).json({ error: "rate limited — try again in a moment" });
  }
  statusRateBuckets.set(ip, now);
  next();
}

app.get("/payment-status", rateLimitStatus, async (req, res) => {
  const ref = req.query.reference;
  if (!ref) return res.status(400).json({ error: "reference required" });

  const pending = pendingPayments.get(ref);
  if (!pending) return res.status(404).json({ error: "unknown or expired reference" });

  // Already activated — just confirm
  if (pending.activated) {
    return res.json({
      paid: true,
      already_active: true,
      session: pending.sessionData?.session || null,
      seconds_granted:
        pending.sessionData?.seconds_granted ||
        pending.minutes * 60,
      tx_hash:
        pending.signature ||
        pending.sessionData?.payment?.transaction ||
        pending.sessionData?.session?.tx_hash ||
        null,
      explorer_url:
        pending.sessionData?.payment?.explorerUrl ||
        (pending.signature
          ? `https://explorer.solana.com/tx/${pending.signature}?cluster=devnet`
          : null),
    });
  }

  try {
    const sigInfo = await findReferenceOnChain(ref);
    const sessionData = await fulfillPendingPayment({
      reference: ref,
      signature: sigInfo.signature,
      buyerWallet: pending.buyerWallet || null,
    });

    console.log(`[Portal] Payment confirmed ${pending.ip} sig=${sigInfo.signature.slice(0, 10)}…`);
    res.json({
      paid: true,
      session: sessionData.session,
      seconds_granted: sessionData.seconds_granted || pending.minutes * 60,
      tx_hash: sigInfo.signature,
      explorer_url:
        sessionData.payment?.explorerUrl ||
        `https://explorer.solana.com/tx/${sigInfo.signature}?cluster=devnet`,
    });

  } catch (err) {
    if (err.name === "FindReferenceError") return res.json({ paid: false });
    console.error("[Portal] payment-status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Captive-portal probe endpoints ────────────────────────────────────────────
//
// These paths are probed by iOS/macOS/Android/Windows immediately after joining
// a new network. We must respond correctly for each OS to trigger the portal:
//
//   • Unpaid → 302 redirect to the payment page  → OS opens captive portal popup
//   • Paid   → 200 "Success" / 204 No Content    → OS considers network open
//
// IMPORTANT: All domains are DNS-resolved to PORTAL_IP, so the Host header
// will differ but the path is what matters.

// Apple (iOS / macOS / tvOS)
// iOS 7-13: http://captive.apple.com/hotspot-detect.html
// iOS 14+ : https://captive.apple.com/hotspot-detect.html  ← hits HTTPS_PORT
// macOS   : same URLs + /library/test/success.html
const APPLE_PROBES = [
  "/hotspot-detect.html",
  "/hotspotdetect.html",
  "/library/test/success.html",
  "/success.html",
  "/canonical.html",
  // Older Apple endpoint (query string is ignored by Express route matching)
  "/bag",
];

function appleProbeResponse(req, res) {
  const ip = clientIP(req);
  if (captiveReleasedIPs.has(ip)) {
    res.set("Content-Type", "text/html");
    res.send("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
  } else {
    // Redirect to portal via port 80 — pf will rdr it to 8888.
    // Using port 80 produces a cleaner URL in the iOS CNA popup browser.
    redirectToPortal(res);
  }
}

app.all(APPLE_PROBES, appleProbeResponse);

// Android (all versions) + Chrome OS
// connectivitycheck.gstatic.com, connectivitycheck.android.com,
// clients3.google.com, play.googleapis.com — all DNS-resolved to PORTAL_IP
app.all(["/generate_204", "/gen_204", "/generate204", "/connectivity-check.html"], (req, res) => {
  const ip = clientIP(req);
  if (captiveReleasedIPs.has(ip)) {
    res.status(204).send();
  } else {
    redirectToPortal(res);
  }
});

// Windows (NCA — Network Connectivity Assistant)
// http://www.msftconnecttest.com/connecttest.txt  (Windows 10+)
// http://www.msftncsi.com/ncsi.txt               (Windows 7/8)
app.all(["/connecttest.txt", "/ncsi.txt", "/redirect"], (req, res) => {
  const ip = clientIP(req);
  if (captiveReleasedIPs.has(ip)) {
    res.set("Content-Type", "text/plain");
    res.send("Microsoft Connect Test");
  } else {
    redirectToPortal(res);
  }
});

// Kindle Fire / Amazon devices
app.get(["/kindle-wifi/wifistub.html", "/kindle-wifi/wifiredirect.html"], (req, res) => {
  const ip = clientIP(req);
  if (captiveReleasedIPs.has(ip)) {
    res.set("Content-Type", "text/html");
    res.send("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
  } else {
    redirectToPortal(res);
  }
});

// ── POST /activate ────────────────────────────────────────────────────────────
//
// Called by the payment page JS when the user taps "Pay & Connect".
// Body: { minutes: number }

app.post("/activate", async (req, res) => {
  const ip      = clientIP(req);
  const minutes = parseInt(req.body?.minutes, 10);

  if (!minutes || minutes < 1) {
    return res.status(400).json({ error: "minutes must be a positive integer" });
  }

  const session_id = uuidv4();
  const tx_hash    = generateReference();

  try {
    // 1. Open the firewall for this IP
    await pfAdd(ip);

    // 2. Register session with the proxy control API (port 3001)
    const r = await fetch(`${CONTROL_API}/sessions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        ip,
        session_id,
        minutes_purchased: minutes,
        tx_hash,
        listing_id: HOTSPOT_CONFIG.listingId,
      }),
    });
    if (!r.ok) throw new Error(`Control API: HTTP ${r.status}`);
    const data = await r.json();

    // 3. Mark IP as paid — DNS forwarding + catch-all work immediately.
    //    Captive probe "Success" is delayed so the user sees the success screen.
    paidIPs.add(ip);
    const CAPTIVE_GRACE_MS = 8000;
    setTimeout(() => captiveReleasedIPs.add(ip), CAPTIVE_GRACE_MS);

    // 4. Auto-expire: close firewall when session time runs out.
    //    scheduleSessionExpiry() cancels any prior timer for this IP first,
    //    so back-to-back activations don't revoke access early.
    scheduleSessionExpiry(ip, minutes * 60 * 1000 + CAPTIVE_GRACE_MS);

    console.log(`[Portal] Activated ${minutes} min session for ${ip} (tx: ${tx_hash.slice(0, 10)}…)`);
    res.json({ ok: true, session: data.session, seconds_granted: data.seconds_granted });

  } catch (err) {
    console.error(`[Portal] Activate failed for ${ip}:`, err.message);
    // Roll back firewall if we opened it
    paidIPs.delete(ip);
    captiveReleasedIPs.delete(ip);
    await pfRemove(ip);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /disconnect ──────────────────────────────────────────────────────────
app.post("/disconnect", async (req, res) => {
  const ip = clientIP(req);
  cancelSessionExpiry(ip);
  paidIPs.delete(ip);
  captiveReleasedIPs.delete(ip);
  await pfRemove(ip);

  try {
    const r = await fetch(`${CONTROL_API}/sessions/${encodeURIComponent(ip)}`, {
      method: "DELETE",
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "control_api_unreachable", message: err.message });
  }
});

// ── GET /status ───────────────────────────────────────────────────────────────
// Payment page polls this to check if its IP is currently paid.
app.get("/status", async (req, res) => {
  const ip   = clientIP(req);
  const paid = paidIPs.has(ip);
  if (!paid) return res.json({ ip, paid });

  try {
    const response = await fetch(`${CONTROL_API}/sessions`);
    const sessions = await response.json();
    const session = sessions.find((item) => item.ip === ip && item.active);
    res.json({ ip, paid, session: session || null });
  } catch {
    res.json({ ip, paid });
  }
});

// ── Catch-all ────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  const ip = clientIP(req);

  if (paidIPs.has(ip)) {
    // Paid client hit the portal via pf rdr on port 80 — redirect to HTTPS
    // version of the site they were trying to reach so they can browse normally.
    const host = req.headers.host;
    if (host && !host.startsWith(PORTAL_IP)) {
      return res.redirect(302, `https://${host}${req.url}`);
    }
    // Fallback: return Apple "Success" so CNA closes
    res.set("Content-Type", "text/html");
    return res.send("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
  }

  // Unpaid client — redirect to payment page via port 80 (pf re-intercepts → 8888)
  res.redirect(302, `http://${PORTAL_IP}/`);
});

app.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`[Portal] HTTP server  → port ${HTTP_PORT}`);
  console.log(`[Portal] Portal URL   → http://${PORTAL_IP}:${HTTP_PORT}`);
});

// ── HTTPS server for modern iOS/macOS captive-portal probes ───────────────────
//
// iOS 14+ probes https://captive.apple.com/hotspot-detect.html.
// pf redirects :443 → :8443 (see setup-pf.sh).
//
// We use a self-signed cert. iOS will see a TLS cert mismatch for captive.apple.com
// AND a non-"Success" body/redirect — both are strong captive-portal signals that
// cause CNA to open. The cert warning never surfaces to the user because CNA
// intercepts the request before rendering a page.
//
// Generate the cert once with:
//   openssl req -x509 -newkey rsa:2048 -keyout captive-portal/tls.key \
//     -out captive-portal/tls.crt -days 3650 -nodes \
//     -subj "/CN=captive.apple.com"
//
// If the cert files don't exist the HTTPS server is skipped (HTTP-only fallback).

(function startHttpsServer() {
  const fs = require("fs");
  const keyPath = path.join(__dirname, "tls.key");
  const crtPath = path.join(__dirname, "tls.crt");

  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    console.warn("[Portal] tls.key / tls.crt not found — HTTPS server skipped.");
    console.warn("[Portal] Run: openssl req -x509 -newkey rsa:2048 -keyout captive-portal/tls.key \\");
    console.warn("[Portal]        -out captive-portal/tls.crt -days 3650 -nodes -subj '/CN=captive.apple.com'");
    return;
  }

  const tlsOptions = {
    key:  fs.readFileSync(keyPath),
    cert: fs.readFileSync(crtPath),
  };

  https.createServer(tlsOptions, app).listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`[Portal] HTTPS server → port ${HTTPS_PORT}`);
  });
})();

// ─── DNS Server ───────────────────────────────────────────────────────────────
//
// Unpaid clients: resolves ALL domains to PORTAL_IP so iOS captive portal
//                 check (captive.apple.com) hits our HTTP server.
// Paid clients:   forwards DNS queries to upstream (8.8.8.8) so they can
//                 actually browse the internet after paying.
//
// pf redirects UDP :53 → :5300 on the bridge interface, so we don't need root.

const { resolve4 } = require("dns");

function isAllowedUnpaidHostname(name) {
  const hostname = String(name || "").replace(/\.$/, "").toLowerCase();
  for (const allowed of DNS_ALLOWLIST) {
    if (hostname === allowed || hostname.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

const dnsServer = dns2.createServer({
  udp: true,
  handle: (request, send, rinfo) => {
    const clientIP = (rinfo?.address || "").replace(/^::ffff:/, "");
    const response = Packet.createResponseFromRequest(request);

    // ── Paid client → forward to real DNS ──
    if (paidIPs.has(clientIP)) {
      const question = request.questions[0];
      if (question && question.type === Packet.TYPE.A) {
        resolve4(question.name, (err, addresses) => {
          if (!err && addresses && addresses.length) {
            for (const addr of addresses) {
              response.answers.push({
                name:    question.name,
                type:    Packet.TYPE.A,
                class:   Packet.CLASS.IN,
                ttl:     60,
                address: addr,
              });
            }
          }
          send(response);
        });
        return;
      }
    }

    // ── Unpaid client → resolve wallet/RPC hosts normally, everything else to portal ──
    for (const question of request.questions) {
      if (question.type === Packet.TYPE.AAAA) {
        // Return NXDOMAIN-style empty answer for IPv6 to force clients onto IPv4.
        // Without this, devices that get a valid AAAA response may connect via
        // IPv6, bypassing pf redirect rules entirely.
        response.header.rcode = 3; // NXDOMAIN
        console.log(`[DNS] Blocking AAAA for ${question.name} from ${clientIP} → forcing IPv4`);
      } else if (question.type === Packet.TYPE.A && isAllowedUnpaidHostname(question.name)) {
        resolve4(question.name, (err, addresses) => {
          if (!err && addresses && addresses.length) {
            for (const addr of addresses) {
              response.answers.push({
                name: question.name,
                type: Packet.TYPE.A,
                class: Packet.CLASS.IN,
                ttl: 60,
                address: addr,
              });
            }
          } else {
            response.answers.push({
              name: question.name,
              type: Packet.TYPE.A,
              class: Packet.CLASS.IN,
              ttl: 10,
              address: PORTAL_IP,
            });
          }
          send(response);
        });
        return;
      } else {
        response.answers.push({
          name:    question.name,
          type:    Packet.TYPE.A,
          class:   Packet.CLASS.IN,
          ttl:     10,         // short TTL so devices don't cache the intercept
          address: PORTAL_IP,
        });
      }
    }

    send(response);
  },
});

dnsServer.listen({ udp: { port: DNS_PORT, address: "0.0.0.0" } });
console.log(`[Portal] DNS server   → port ${DNS_PORT}`);
console.log(`[Portal] Resolving all domains → ${PORTAL_IP}`);
console.log("");
console.log("Ready. Waiting for iPhone to connect to your Mac hotspot…");
