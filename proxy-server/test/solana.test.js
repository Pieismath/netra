"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bs58 = require("bs58");
const { PublicKey } = require("@solana/web3.js");

const {
  RpcPool,
  RpcUnavailableError,
  BlockhashExpiredError,
  PaymentNotFinalizedError,
  generateReference,
  parseRpcUrls,
  sendSolanaRefundWithRetry,
  verifySolanaPayment,
  __test__: {
    extractMemoText,
    isTransientRpcError,
    isBlockhashExpiredError,
    isInsufficientFundsError,
    fetchParsedWithTimeout,
  },
} = require("../lib/solana");

function fakeFetchError(message = "fetch failed") {
  const err = new Error(message);
  return err;
}

test("RpcPool: round-robins across healthy endpoints", async () => {
  const pool = new RpcPool(["http://a", "http://b", "http://c"]);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await pool.execute(async (url) => {
      seen.push(url);
      return "ok";
    });
  }
  assert.deepEqual(seen, [
    "http://a",
    "http://b",
    "http://c",
    "http://a",
    "http://b",
    "http://c",
  ]);
});

test("RpcPool: circuit breaker trips after 3 consecutive failures and recovers after cooldown", async () => {
  let now = 1_000_000;
  const pool = new RpcPool(["http://a", "http://b"], {
    threshold: 3,
    cooldownMs: 60_000,
    now: () => now,
  });

  // Fail "a" 3 times in a row by forcing each call to start at "a" (cursor reset).
  for (let i = 0; i < 3; i++) {
    pool.cursor = 0;
    await pool.execute(async (url) => {
      if (url === "http://a") throw fakeFetchError();
      return "fallback";
    });
  }

  const healthBeforeCooldown = pool.endpointHealth();
  const aHealth = healthBeforeCooldown.find((h) => h.url === "http://a");
  assert.equal(aHealth.healthy, false, "endpoint a should be marked unhealthy after 3 failures");
  assert.equal(aHealth.consecutiveFailures, 3);
  assert.equal(aHealth.unhealthyUntil, now + 60_000);

  // While "a" is unhealthy, the pool must skip it.
  pool.cursor = 0;
  const skipResult = await pool.execute(async (url) => {
    assert.notEqual(url, "http://a", "unhealthy endpoint must be skipped while in cooldown");
    return "from-b";
  });
  assert.equal(skipResult, "from-b");

  // Advance past the cooldown — endpoint "a" should be selectable again, and a success resets state.
  now += 60_001;
  pool.cursor = 0;
  const recovered = await pool.execute(async (url) => {
    return url; // succeed wherever we land
  });
  assert.ok(recovered === "http://a" || recovered === "http://b");

  // If we recovered via "a", failures should reset to 0.
  if (recovered === "http://a") {
    const aAfter = pool.endpointHealth().find((h) => h.url === "http://a");
    assert.equal(aAfter.consecutiveFailures, 0);
    assert.equal(aAfter.unhealthyUntil, 0);
  }
});

test("RpcPool: throws RpcUnavailableError when all endpoints are unhealthy or fail", async () => {
  const pool = new RpcPool(["http://a", "http://b"], { threshold: 1 });
  await assert.rejects(
    pool.execute(async () => {
      throw fakeFetchError("network error: socket hang up");
    }),
    (err) => {
      assert.ok(err instanceof RpcUnavailableError, "expected RpcUnavailableError");
      assert.match(err.message, /All 2 Solana RPC endpoint/);
      return true;
    }
  );
});

test("RpcPool: propagates non-transient errors immediately without tripping the breaker", async () => {
  const pool = new RpcPool(["http://a", "http://b"]);
  let callCount = 0;
  await assert.rejects(
    pool.execute(async () => {
      callCount += 1;
      throw new Error("Transaction is missing the required x402 payment reference");
    }),
    (err) => {
      assert.ok(!(err instanceof RpcUnavailableError));
      assert.match(err.message, /missing the required x402/);
      return true;
    }
  );
  assert.equal(callCount, 1, "non-transient error should not retry on other endpoints");
  const aHealth = pool.endpointHealth().find((h) => h.url === "http://a");
  assert.equal(aHealth.consecutiveFailures, 0, "non-transient error must not penalize endpoint health");
});

test("RpcPool: a successful call after failures resets the failure counter", async () => {
  const pool = new RpcPool(["http://a"]);
  // Two transient failures.
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      pool.execute(async () => {
        throw fakeFetchError();
      })
    );
  }
  let aHealth = pool.endpointHealth().find((h) => h.url === "http://a");
  assert.equal(aHealth.consecutiveFailures, 2);

  // One success — counter resets.
  await pool.execute(async () => "ok");
  aHealth = pool.endpointHealth().find((h) => h.url === "http://a");
  assert.equal(aHealth.consecutiveFailures, 0);
});

test("isTransientRpcError: classifies common transient errors", () => {
  assert.equal(isTransientRpcError(new Error("fetch failed")), true);
  assert.equal(isTransientRpcError(new Error("server responded with 503 Service Unavailable")), true);
  assert.equal(isTransientRpcError(new Error("rate limit exceeded")), true);
  assert.equal(isTransientRpcError(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientRpcError(new RpcUnavailableError("all out")), true);
  assert.equal(isTransientRpcError(new BlockhashExpiredError("expired")), true);

  assert.equal(isTransientRpcError(new Error("Transaction failed on-chain")), false);
  assert.equal(isTransientRpcError(new Error("Missing payment reference")), false);
  assert.equal(isTransientRpcError(new PaymentNotFinalizedError("not yet")), false);
});

test("isBlockhashExpiredError: detects blockhash and expiry errors", () => {
  assert.equal(isBlockhashExpiredError(new Error("block height exceeded")), true);
  assert.equal(isBlockhashExpiredError(new Error("Blockhash not found")), true);
  assert.equal(isBlockhashExpiredError(new Error("transaction has expired")), true);
  assert.equal(isBlockhashExpiredError(new Error("something else")), false);
});

test("isInsufficientFundsError: detects funding errors", () => {
  assert.equal(isInsufficientFundsError(new Error("insufficient lamports for rent")), true);
  assert.equal(isInsufficientFundsError(new Error("insufficient funds for transfer")), true);
  assert.equal(isInsufficientFundsError(new Error("Attempt to debit an account but found no record")), true);
  assert.equal(isInsufficientFundsError(new Error("network timeout")), false);
});

test("parseRpcUrls: splits comma-separated env value and trims whitespace", () => {
  assert.deepEqual(parseRpcUrls("https://a.example, https://b.example , https://c.example"), [
    "https://a.example",
    "https://b.example",
    "https://c.example",
  ]);
  assert.deepEqual(parseRpcUrls("https://only.example"), ["https://only.example"]);
  // Empty/missing falls back to devnet cluster URL.
  const fallback = parseRpcUrls("");
  assert.equal(fallback.length, 1);
  assert.match(fallback[0], /devnet/);
});

test("extractMemoText: returns parsed string directly", () => {
  assert.equal(extractMemoText({ parsed: "netra:abc123", program: "spl-memo" }), "netra:abc123");
});

test("extractMemoText: decodes base58 instruction.data", () => {
  const original = "netra:5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY";
  const data = bs58.encode(Buffer.from(original, "utf8"));
  assert.equal(extractMemoText({ data }), original);
});

test("extractMemoText: returns null when no parseable content", () => {
  assert.equal(extractMemoText({}), null);
  assert.equal(extractMemoText(null), null);
  assert.equal(extractMemoText({ data: "" }), null);
});

test("memo validation: memoMatchesReference is true when memo contains the reference", async () => {
  const reference = generateReference();
  const destination = new PublicKey(Buffer.alloc(32, 7)).toBase58();
  const buyer = new PublicKey(Buffer.alloc(32, 9)).toBase58();
  const memoText = `netra:${reference}`;

  const fakePool = {
    execute: async (fn) => fn("http://stub"),
  };

  const fakeParsed = {
    slot: 42,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: new PublicKey(buyer), signer: true },
          { pubkey: new PublicKey(destination), signer: false },
          { pubkey: new PublicKey(reference), signer: false },
        ],
        instructions: [
          {
            program: "system",
            programId: { toBase58: () => "11111111111111111111111111111111" },
            parsed: {
              type: "transfer",
              info: { destination, lamports: 100_000 },
            },
          },
          {
            program: "spl-memo",
            programId: {
              toBase58: () => "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            },
            parsed: memoText,
          },
        ],
      },
    },
  };

  // Patch pool.execute to return our fake parsed transaction directly,
  // bypassing Connection. We do this by monkey-patching the inner fn.
  fakePool.execute = async () => fakeParsed;

  const result = await verifySolanaPayment({
    signature: "fake-sig",
    reference,
    destination,
    amountLamports: 100_000,
    pool: fakePool,
  });

  assert.equal(result.memoPresent, true);
  assert.equal(result.memoText, memoText);
  assert.equal(result.memoMatchesReference, true);
  assert.equal(result.buyerWallet, buyer);
  assert.equal(result.transferredLamports, 100_000);
});

test("memo validation: memoMatchesReference is false when memo lacks the reference", async () => {
  const reference = generateReference();
  const destination = new PublicKey(Buffer.alloc(32, 7)).toBase58();
  const memoText = "netra:wrong-reference-string";

  const fakeParsed = {
    slot: 1,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: new PublicKey(Buffer.alloc(32, 9)), signer: true },
          { pubkey: new PublicKey(destination), signer: false },
          { pubkey: new PublicKey(reference), signer: false },
        ],
        instructions: [
          {
            program: "system",
            programId: { toBase58: () => "11111111111111111111111111111111" },
            parsed: { type: "transfer", info: { destination, lamports: 100 } },
          },
          {
            program: "spl-memo",
            programId: {
              toBase58: () => "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            },
            parsed: memoText,
          },
        ],
      },
    },
  };

  const result = await verifySolanaPayment({
    signature: "fake-sig",
    reference,
    destination,
    amountLamports: 100,
    pool: { execute: async () => fakeParsed },
  });

  assert.equal(result.memoPresent, true);
  assert.equal(result.memoText, memoText);
  assert.equal(result.memoMatchesReference, false);
});

test("memo validation: decodes base58 data when memo is not pre-parsed", async () => {
  const reference = generateReference();
  const destination = new PublicKey(Buffer.alloc(32, 5)).toBase58();
  const memoText = `netra:${reference}`;
  const memoData = bs58.encode(Buffer.from(memoText, "utf8"));

  const fakeParsed = {
    slot: 7,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: new PublicKey(Buffer.alloc(32, 3)), signer: true },
          { pubkey: new PublicKey(destination), signer: false },
          { pubkey: new PublicKey(reference), signer: false },
        ],
        instructions: [
          {
            program: "system",
            programId: { toBase58: () => "11111111111111111111111111111111" },
            parsed: { type: "transfer", info: { destination, lamports: 50 } },
          },
          {
            programId: {
              toBase58: () => "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
            },
            data: memoData,
          },
        ],
      },
    },
  };

  const result = await verifySolanaPayment({
    signature: "fake-sig",
    reference,
    destination,
    amountLamports: 50,
    pool: { execute: async () => fakeParsed },
  });

  assert.equal(result.memoMatchesReference, true);
  assert.equal(result.memoText, memoText);
});

test("verifySolanaPayment: throws PaymentNotFinalizedError when RPC returns null", async () => {
  await assert.rejects(
    verifySolanaPayment({
      signature: "fake-sig",
      reference: generateReference(),
      destination: new PublicKey(Buffer.alloc(32, 1)).toBase58(),
      amountLamports: 100,
      pool: { execute: async () => null },
    }),
    (err) => {
      assert.ok(err instanceof PaymentNotFinalizedError);
      return true;
    }
  );
});

test("fetchParsedWithTimeout: rejects with PaymentNotFinalizedError if rpc hangs", async () => {
  const fakeConnection = {
    getParsedTransaction: () => new Promise(() => {}), // never resolves
  };
  await assert.rejects(
    fetchParsedWithTimeout(fakeConnection, "sig", 50),
    (err) => {
      assert.ok(err instanceof PaymentNotFinalizedError);
      assert.match(err.message, /did not finalize within 50ms/);
      return true;
    }
  );
});

test("fetchParsedWithTimeout: returns the rpc result when it resolves in time", async () => {
  const fakeConnection = {
    getParsedTransaction: async () => ({ slot: 1, meta: { err: null } }),
  };
  const result = await fetchParsedWithTimeout(fakeConnection, "sig", 1_000);
  assert.deepEqual(result, { slot: 1, meta: { err: null } });
});

test("sendSolanaRefundWithRetry: retries on transient errors and eventually succeeds", async () => {
  // Stub the default pool by injecting one whose execute throws transient errors twice, then succeeds.
  let attempts = 0;
  const transientPool = {
    execute: async (fn) => {
      attempts += 1;
      if (attempts < 3) {
        throw new RpcUnavailableError("All endpoints down");
      }
      return fn("http://stub");
    },
  };

  // The fn passed by sendSolanaRefund returns a refund object once it runs.
  // To bypass the actual refund logic, we use a buyer wallet fixture and a stub pool whose fn handler
  // is bypassed — the final attempt of execute returns whatever fn returns. So our fn won't actually run
  // unless we pass a real Connection. Instead, make execute itself return the success payload directly.
  transientPool.execute = async () => {
    attempts += 1;
    if (attempts < 3) throw new RpcUnavailableError("All endpoints down");
    return {
      status: "sent",
      signature: "ok-sig",
      explorerUrl: "https://explorer.test/ok-sig",
      sourceWallet: "src",
    };
  };

  // Patch sendSolanaRefund via swapping pool — but sendSolanaRefundWithRetry calls sendSolanaRefund
  // which uses the default pool unless we pass `pool` through opts. We support that.
  const result = await sendSolanaRefundWithRetry(
    {
      destination: new PublicKey(Buffer.alloc(32, 8)).toBase58(),
      amountLamports: 1_000,
      memo: "test",
      pool: transientPool,
      __sleep: () => Promise.resolve(), // skip real backoff
    },
    3
  );
  assert.equal(result.status, "sent");
  assert.equal(result.signature, "ok-sig");
  assert.equal(attempts, 3);
});

test("sendSolanaRefundWithRetry: does not retry on insufficient funds (permanent error)", async () => {
  let attempts = 0;
  const failingPool = {
    execute: async () => {
      attempts += 1;
      throw new Error("insufficient funds for transfer");
    },
  };

  await assert.rejects(
    sendSolanaRefundWithRetry(
      {
        destination: new PublicKey(Buffer.alloc(32, 8)).toBase58(),
        amountLamports: 1_000,
        memo: "test",
        pool: failingPool,
        __sleep: () => Promise.resolve(),
      },
      3
    ),
    (err) => {
      assert.match(err.message, /insufficient funds/);
      return true;
    }
  );
  assert.equal(attempts, 1, "permanent errors must not retry");
});

test("sendSolanaRefundWithRetry: gives up after the configured attempts on persistent transient errors", async () => {
  let attempts = 0;
  const failingPool = {
    execute: async () => {
      attempts += 1;
      throw new RpcUnavailableError("still down");
    },
  };

  await assert.rejects(
    sendSolanaRefundWithRetry(
      {
        destination: new PublicKey(Buffer.alloc(32, 8)).toBase58(),
        amountLamports: 1_000,
        memo: "test",
        pool: failingPool,
        __sleep: () => Promise.resolve(),
      },
      3
    ),
    (err) => err instanceof RpcUnavailableError
  );
  assert.equal(attempts, 3);
});
