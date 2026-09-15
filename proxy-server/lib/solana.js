"use strict";

const crypto = require("crypto");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

const RPC_CIRCUIT_BREAKER_THRESHOLD = 3;
const RPC_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const FINALIZED_COMMITMENT_TIMEOUT_MS = 30_000;
const REFUND_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];

class RpcUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RpcUnavailableError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

class PaymentNotFinalizedError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "PaymentNotFinalizedError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

class BlockhashExpiredError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BlockhashExpiredError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function isTransientRpcError(err) {
  if (!err) return false;
  if (err instanceof RpcUnavailableError) return true;
  if (err instanceof BlockhashExpiredError) return true;
  if (err instanceof PaymentNotFinalizedError) return false;

  const code = err.code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ENETUNREACH" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }

  const msg = String(err.message || "");
  if (/fetch failed|network error|socket hang up|request timed out|ETIMEDOUT/i.test(msg)) {
    return true;
  }
  if (/HTTP error.*5\d\d|server responded with 5\d\d|server responded with 429|status code 5\d\d|status code 429/i.test(msg)) {
    return true;
  }
  if (/rate.?limit|too many requests/i.test(msg)) {
    return true;
  }
  return false;
}

function isBlockhashExpiredError(err) {
  if (!err) return false;
  if (err instanceof BlockhashExpiredError) return true;
  const name = err?.constructor?.name || "";
  if (
    name === "TransactionExpiredBlockheightExceededError" ||
    name === "TransactionExpiredTimeoutError" ||
    name === "TransactionExpiredNonceInvalidError"
  ) {
    return true;
  }
  const msg = String(err.message || "");
  return /block.?height exceeded|blockhash not found|transaction.*(?:expired|too old)/i.test(msg);
}

function isInsufficientFundsError(err) {
  const msg = String(err?.message || "");
  return /insufficient (?:lamports|funds|balance)|underfunded|attempt to debit an account but found no record/i.test(msg);
}

class RpcPool {
  constructor(urls, options = {}) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error("RpcPool requires at least one URL");
    }
    this.endpoints = urls.map((url) => ({
      url,
      consecutiveFailures: 0,
      unhealthyUntil: 0,
    }));
    this.cursor = 0;
    this.threshold = options.threshold ?? RPC_CIRCUIT_BREAKER_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? RPC_CIRCUIT_BREAKER_COOLDOWN_MS;
    this.now = options.now || (() => Date.now());
  }

  get urls() {
    return this.endpoints.map((ep) => ep.url);
  }

  endpointHealth() {
    const t = this.now();
    return this.endpoints.map((ep) => ({
      url: ep.url,
      healthy: ep.unhealthyUntil <= t,
      consecutiveFailures: ep.consecutiveFailures,
      unhealthyUntil: ep.unhealthyUntil,
    }));
  }

  _selectIndex() {
    const total = this.endpoints.length;
    const t = this.now();
    for (let i = 0; i < total; i++) {
      const idx = (this.cursor + i) % total;
      if (this.endpoints[idx].unhealthyUntil <= t) {
        return idx;
      }
    }
    return -1;
  }

  _recordSuccess(ep) {
    ep.consecutiveFailures = 0;
    ep.unhealthyUntil = 0;
  }

  _recordFailure(ep) {
    ep.consecutiveFailures += 1;
    if (ep.consecutiveFailures >= this.threshold) {
      ep.unhealthyUntil = this.now() + this.cooldownMs;
    }
  }

  async execute(fn) {
    const tried = new Set();
    let lastError;
    while (tried.size < this.endpoints.length) {
      const idx = this._selectIndex();
      if (idx < 0) break;
      const ep = this.endpoints[idx];
      if (tried.has(ep)) {
        this.cursor = (idx + 1) % this.endpoints.length;
        continue;
      }
      tried.add(ep);
      this.cursor = (idx + 1) % this.endpoints.length;
      try {
        const result = await fn(ep.url);
        this._recordSuccess(ep);
        return result;
      } catch (err) {
        if (!isTransientRpcError(err)) {
          throw err;
        }
        this._recordFailure(ep);
        lastError = err;
      }
    }
    throw new RpcUnavailableError(
      `All ${this.endpoints.length} Solana RPC endpoint(s) failed`,
      { cause: lastError }
    );
  }
}

function parseRpcUrls(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [clusterApiUrl("devnet")];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSolanaRpcUrl() {
  return parseRpcUrls(process.env.SOLANA_RPC)[0];
}

function getSolanaRpcUrls() {
  return parseRpcUrls(process.env.SOLANA_RPC);
}

let _defaultPool = null;
function getDefaultPool() {
  if (!_defaultPool) {
    _defaultPool = new RpcPool(getSolanaRpcUrls());
  }
  return _defaultPool;
}

function resetDefaultPool() {
  _defaultPool = null;
}

function normalizeWallet(wallet) {
  if (!wallet) return null;
  try {
    return new PublicKey(wallet).toBase58();
  } catch {
    return null;
  }
}

function generateReference() {
  return new PublicKey(crypto.randomBytes(32)).toBase58();
}

function formatSol(amountLamports) {
  return Number(amountLamports) / LAMPORTS_PER_SOL;
}

function explorerUrl(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function parseSecretKey(value, envName) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return Uint8Array.from(parsed);
    }
  } catch (_) {
    // not JSON — fall through to base58
  }

  try {
    const bs58 = require("bs58");
    const decoded = bs58.decode(value);
    if (decoded.length === 64) return decoded;
  } catch (_) {
    // not valid base58
  }

  throw new Error(`${envName} must be a JSON array or base58 Solana secret key`);
}

function createNetraDemoRefundKeypair() {
  const seed = crypto
    .createHash("sha256")
    .update("netra-demo-refund-treasury-v1")
    .digest()
    .subarray(0, 32);

  return Keypair.fromSeed(seed);
}

let _selfRefundWarned = false;
function maybeWarnSelfRefund(refundKeypair) {
  if (_selfRefundWarned || !refundKeypair) return;
  const refundPubkey = refundKeypair.publicKey.toBase58();
  const destination = normalizeWallet(process.env.SOLANA_WALLET);
  if (destination && destination === refundPubkey) {
    _selfRefundWarned = true;
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "solana.self_refund_detected",
        message:
          "Refund signer pubkey equals SOLANA_WALLET destination — fine for demos, surprising in production",
        pubkey: refundPubkey,
      })
    );
  }
}

function getRefundKeypair(rpcUrl = getSolanaRpcUrl()) {
  let keypair = null;
  if (process.env.SOLANA_REFUND_SECRET_KEY) {
    keypair = Keypair.fromSecretKey(
      parseSecretKey(process.env.SOLANA_REFUND_SECRET_KEY, "SOLANA_REFUND_SECRET_KEY")
    );
  } else if (String(rpcUrl).includes("devnet")) {
    keypair = createNetraDemoRefundKeypair();
  }

  if (keypair) maybeWarnSelfRefund(keypair);
  return keypair;
}

async function ensureRefundBalance(connection, keypair, minimumLamports) {
  const currentBalance = await connection.getBalance(keypair.publicKey, "confirmed");
  if (currentBalance >= minimumLamports) {
    return { currentBalance, airdropSignature: null };
  }

  if (!String(connection.rpcEndpoint || "").includes("devnet")) {
    throw new Error("Refund wallet is underfunded and automatic top-ups are only enabled on devnet");
  }

  const topUpLamports = Math.max(
    LAMPORTS_PER_SOL,
    minimumLamports - currentBalance + Math.round(0.05 * LAMPORTS_PER_SOL)
  );

  const airdropSignature = await connection.requestAirdrop(keypair.publicKey, topUpLamports);
  const blockhash = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature: airdropSignature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    },
    "confirmed"
  );

  return { currentBalance, airdropSignature };
}

async function sendSolanaRefund({
  destination,
  amountLamports,
  memo,
  pool = getDefaultPool(),
}) {
  const lamports = Number(amountLamports || 0);
  if (!lamports) {
    return { status: "not_needed" };
  }

  const normalizedDestination = normalizeWallet(destination);
  if (!normalizedDestination) {
    return { status: "unavailable", error: "Missing buyer wallet for refund" };
  }

  return pool.execute(async (rpcUrl) => {
    const refundKeypair = getRefundKeypair(rpcUrl);
    if (!refundKeypair) {
      return { status: "pending_config", error: "Refund signer is not configured" };
    }

    const refundSource = refundKeypair.publicKey.toBase58();
    const connection = new Connection(rpcUrl, "confirmed");
    await ensureRefundBalance(connection, refundKeypair, lamports + 10_000);

    const latest = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: refundKeypair.publicKey,
      recentBlockhash: latest.blockhash,
    });

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: refundKeypair.publicKey,
        toPubkey: new PublicKey(normalizedDestination),
        lamports,
      })
    );

    if (memo) {
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM_ID,
          data: Buffer.from(String(memo), "utf8"),
        })
      );
    }

    let signature;
    try {
      signature = await connection.sendTransaction(transaction, [refundKeypair], {
        maxRetries: 3,
        preflightCommitment: "confirmed",
      });

      const result = await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );

      if (result?.value?.err) {
        throw new Error(
          `Refund transaction failed on-chain: ${JSON.stringify(result.value.err)}`
        );
      }
    } catch (err) {
      if (isBlockhashExpiredError(err)) {
        throw new BlockhashExpiredError(
          "Refund blockhash expired before confirmation",
          { cause: err }
        );
      }
      throw err;
    }

    return {
      status: "sent",
      signature,
      explorerUrl: explorerUrl(signature),
      sourceWallet: refundSource,
    };
  });
}

async function sendSolanaRefundWithRetry(opts, attempts = 3) {
  const sleep = opts && typeof opts.__sleep === "function"
    ? opts.__sleep
    : (ms) => new Promise((r) => setTimeout(r, ms));
  const callOpts = { ...opts };
  delete callOpts.__sleep;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await sendSolanaRefund(callOpts);
    } catch (err) {
      lastError = err;

      if (isInsufficientFundsError(err)) {
        throw err;
      }

      const transient =
        err instanceof RpcUnavailableError ||
        err instanceof BlockhashExpiredError ||
        isTransientRpcError(err);

      if (!transient) throw err;
      if (attempt + 1 >= attempts) break;

      const delay = REFUND_RETRY_BACKOFF_MS[Math.min(attempt, REFUND_RETRY_BACKOFF_MS.length - 1)];
      await sleep(delay);
    }
  }
  throw lastError;
}

function extractMemoText(instruction) {
  if (!instruction) return null;

  if (typeof instruction.parsed === "string") {
    return instruction.parsed;
  }
  if (instruction.parsed && typeof instruction.parsed === "object") {
    if (typeof instruction.parsed.memo === "string") return instruction.parsed.memo;
    if (typeof instruction.parsed.message === "string") return instruction.parsed.message;
  }
  if (typeof instruction.data === "string" && instruction.data) {
    try {
      const bs58 = require("bs58");
      const decoded = bs58.decode(instruction.data);
      return Buffer.from(decoded).toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}

function instructionProgramId(instruction) {
  const programId = instruction?.programId;
  if (!programId) return null;
  if (typeof programId.toBase58 === "function") return programId.toBase58();
  return String(programId);
}

async function verifySolanaPayment({
  signature,
  reference,
  destination,
  amountLamports,
  pool = getDefaultPool(),
  finalizedTimeoutMs = FINALIZED_COMMITMENT_TIMEOUT_MS,
}) {
  if (!signature) {
    throw new Error("Missing Solana transaction signature");
  }

  if (!reference) {
    throw new Error("Missing payment reference");
  }

  const parsed = await pool.execute(async (rpcUrl) => {
    const connection = new Connection(rpcUrl, "finalized");
    return fetchParsedWithTimeout(connection, signature, finalizedTimeoutMs);
  });

  if (!parsed) {
    throw new PaymentNotFinalizedError(
      `Transaction ${signature} is not yet finalized on Solana`
    );
  }

  if (parsed.meta?.err) {
    throw new Error("Transaction failed on-chain");
  }

  const accountKeys = parsed.transaction.message.accountKeys.map((entry) => ({
    pubkey:
      entry && typeof entry === "object" && "pubkey" in entry
        ? entry.pubkey.toBase58()
        : String(entry),
    signer: Boolean(entry && typeof entry === "object" && "signer" in entry && entry.signer),
  }));

  const includesReference = accountKeys.some((entry) => entry.pubkey === reference);
  if (!includesReference) {
    throw new Error("Transaction is missing the required x402 payment reference");
  }

  const expectedDestination = normalizeWallet(destination);
  if (!expectedDestination) {
    throw new Error("Destination wallet is not configured");
  }

  const transfer = parsed.transaction.message.instructions.find((instruction) => {
    if (!("parsed" in instruction) || instruction.program !== "system") return false;
    if (instruction.parsed?.type !== "transfer") return false;
    const info = instruction.parsed.info || {};
    return (
      info.destination === expectedDestination &&
      Number(info.lamports || 0) >= Number(amountLamports || 0)
    );
  });

  if (!transfer) {
    throw new Error("Transaction does not pay the required hotspot amount");
  }

  const buyerWallet =
    accountKeys.find((entry) => entry.signer)?.pubkey || null;

  const memoProgramId = MEMO_PROGRAM_ID.toBase58();
  const memoInstruction = parsed.transaction.message.instructions.find(
    (instruction) => instructionProgramId(instruction) === memoProgramId
  );

  const memoPresent = Boolean(memoInstruction);
  const memoText = memoInstruction ? extractMemoText(memoInstruction) : null;
  const memoMatchesReference = Boolean(memoText && memoText.includes(reference));

  return {
    signature,
    slot: parsed.slot,
    buyerWallet,
    transferredLamports: Number(transfer.parsed.info.lamports || 0),
    memoPresent,
    memoText,
    memoMatchesReference,
    explorerUrl: explorerUrl(signature),
  };
}

async function fetchParsedWithTimeout(connection, signature, timeoutMs) {
  const fetchPromise = connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "finalized",
  });
  // Attach a no-op handler so a late rejection (after the timeout wins the race)
  // doesn't get reported as an unhandled promise rejection.
  fetchPromise.catch(() => {});

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new PaymentNotFinalizedError(
          `Transaction ${signature} did not finalize within ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  });

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

module.exports = {
  LAMPORTS_PER_SOL,
  MEMO_PROGRAM_ID,
  RpcPool,
  RpcUnavailableError,
  PaymentNotFinalizedError,
  BlockhashExpiredError,
  explorerUrl,
  formatSol,
  generateReference,
  getDefaultPool,
  getSolanaRpcUrl,
  getSolanaRpcUrls,
  normalizeWallet,
  parseRpcUrls,
  resetDefaultPool,
  sendSolanaRefund,
  sendSolanaRefundWithRetry,
  verifySolanaPayment,
  __test__: {
    extractMemoText,
    isBlockhashExpiredError,
    isInsufficientFundsError,
    isTransientRpcError,
    instructionProgramId,
    fetchParsedWithTimeout,
  },
};
