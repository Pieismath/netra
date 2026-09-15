"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SCHEMA_VERSION = 1;

/**
 * Artifact JSON shape (schema_version 1)
 *
 * Every artifact JSON has a top-level `schema_version` (number) followed by
 * the caller-supplied payload. lib/hotspot-service.js currently emits these
 * kinds:
 *
 *   "session-receipt" | "session-extension" | "session-closeout"
 *     { artifactKind, sessionId, listingId, hostId, hostWallet,
 *       buyer:   { redactedIp, redactedWallet, sessionType },
 *       time:    { startedAt, paidUntil, endedAt },
 *       usage:   { minutesPurchased, minutesUsed, bytesForwarded },
 *       payment: { txHash, reference, amountSol, amountLamports, explorerUrl, source },
 *       refund:  null | { ... },
 *       status, statusTransitions, extra, generatedAt }
 *
 *   "host-profile"
 *     { listingId, name, ssid, location,
 *       pricing: { ratePerMinuteSol },
 *       policies, aggregateUsage, updatedAt }
 *
 *   "reputation"
 *     { listingId, hostWallet, successfulSessions, refunds, disconnectRate,
 *       slaFailures, reliabilityScore, updatedAt }
 *
 * Storage layout under `${dataDir}/artifacts/`:
 *   <cid>.json     uncompressed canonical bytes (durable, locally readable)
 *   <cid>.json.gz  gzipped copy uploaded to Filecoin/Synapse by the worker
 *
 * The upload queue lives at `${dataDir}/upload-queue.json` and tracks retry
 * state for in-flight uploads. CIDs hash uncompressed bytes (with
 * schema_version included), so they remain stable across compression and
 * unaffected by gzip metadata.
 */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function createDeterministicCid(payload) {
  const [{ CID }, raw, { sha256 }] = await Promise.all([
    import("multiformats/cid"),
    import("multiformats/codecs/raw"),
    import("multiformats/hashes/sha2"),
  ]);

  const versioned = { schema_version: SCHEMA_VERSION, ...payload };
  const bytes = Buffer.from(JSON.stringify(versioned));
  const hash = await sha256.digest(bytes);
  return CID.createV1(raw.code, hash).toString();
}

const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 3_600_000];
const MAX_QUEUE_DURATION_MS = 24 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 5_000;

function backoffForAttempt(attempts) {
  const idx = Math.min(Math.max(0, attempts - 1), BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}

async function uploadToSynapse({ bytes, metadata }) {
  const privateKey = process.env.FILECOIN_PRIVATE_KEY;
  if (!privateKey) {
    return { uploaded: false, reason: "FILECOIN_PRIVATE_KEY not set" };
  }

  const [{ Synapse, calibration, mainnet, devnet }, { http }, { privateKeyToAccount }] =
    await Promise.all([
      import("@filoz/synapse-sdk"),
      import("viem"),
      import("viem/accounts"),
    ]);

  const network = process.env.FILECOIN_NETWORK || "calibration";
  const chainMap = { calibration, mainnet, devnet };
  const chain = chainMap[network] || calibration;
  const transport = http(
    process.env.FILECOIN_RPC_URL || chain.rpcUrls.default.http[0]
  );

  const synapse = Synapse.create({
    account: privateKeyToAccount(privateKey),
    chain,
    transport,
    withCDN: process.env.FILECOIN_WITH_CDN === "true",
    source: process.env.FILECOIN_SOURCE || "netra",
  });

  const result = await synapse.storage.upload(new Blob([bytes]), {
    pieceMetadata: metadata,
  });

  return {
    uploaded: true,
    network,
    pieceCid: String(result.pieceCid),
    copies: result.copies?.length || 0,
  };
}

function createUploadQueue({ dataDir, runUpload = uploadToSynapse } = {}) {
  if (!dataDir) throw new Error("createUploadQueue requires dataDir");

  const queuePath = path.join(dataDir, "upload-queue.json");
  const persisted = readJson(queuePath, null) || {};
  const items =
    persisted && typeof persisted.items === "object" && persisted.items
      ? persisted.items
      : {};

  let processing = false;
  let timer = null;

  function persistQueue() {
    writeJson(queuePath, { schema_version: 1, items });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function enqueue({ cid, kind, gzPath, metadata }) {
    if (!items[cid]) {
      items[cid] = {
        cid,
        kind,
        gzPath,
        metadata,
        state: "pending",
        attempts: 0,
        lastError: null,
        lastAttempt: null,
        nextAttemptAt: nowIso(),
        firstQueuedAt: nowIso(),
        pieceCid: null,
        network: null,
        copies: 0,
      };
      persistQueue();
    }
    return items[cid];
  }

  function getStatus(cid) {
    const item = items[cid];
    if (!item) return null;
    return {
      state: item.state,
      attempts: item.attempts,
      lastError: item.lastError,
      lastAttempt: item.lastAttempt,
      pieceCid: item.pieceCid,
    };
  }

  async function attempt(item) {
    item.attempts += 1;
    item.lastAttempt = nowIso();

    let bytes;
    try {
      bytes = fs.readFileSync(item.gzPath);
    } catch (error) {
      item.state = "failed";
      item.lastError = `Missing gzipped artifact at ${item.gzPath}: ${error.message}`;
      persistQueue();
      return;
    }

    try {
      const result = await runUpload({ bytes, metadata: item.metadata });
      if (result && result.uploaded) {
        item.state = "uploaded";
        item.pieceCid = result.pieceCid || null;
        item.network = result.network || null;
        item.copies = result.copies || 0;
        item.lastError = null;
        persistQueue();
        return;
      }
      throw new Error((result && result.reason) || "Synapse upload failed");
    } catch (error) {
      item.lastError = error instanceof Error ? error.message : String(error);
      const queuedFor = Date.now() - new Date(item.firstQueuedAt).getTime();
      if (queuedFor >= MAX_QUEUE_DURATION_MS) {
        item.state = "failed";
      } else {
        item.state = "pending";
        item.nextAttemptAt = new Date(
          Date.now() + backoffForAttempt(item.attempts)
        ).toISOString();
      }
      persistQueue();
    }
  }

  async function tick() {
    if (processing) return;
    processing = true;
    try {
      const due = Date.now();
      const ready = Object.values(items).filter(
        (item) =>
          item.state === "pending" &&
          new Date(item.nextAttemptAt).getTime() <= due
      );
      for (const item of ready) {
        await attempt(item);
      }
    } finally {
      processing = false;
    }
  }

  function start() {
    if (timer) return;
    if (!process.env.FILECOIN_PRIVATE_KEY) return;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, TICK_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { enqueue, getStatus, start, stop, tick, items };
}

function createArtifactStore({ dataDir, runUpload, onPersist = null } = {}) {
  if (!dataDir) throw new Error("createArtifactStore requires dataDir");
  const artifactsDir = path.join(dataDir, "artifacts");
  ensureDir(artifactsDir);

  const queue = createUploadQueue({ dataDir, runUpload });
  queue.start();

  return {
    dataDir,
    readJson,
    writeJson,
    getUploadStatus(cid) {
      return queue.getStatus(cid);
    },
    stopUploadWorker() {
      queue.stop();
    },
    async persist(kind, payload, metadata = {}) {
      const versionedPayload = { schema_version: SCHEMA_VERSION, ...payload };
      const cid = await createDeterministicCid(payload);

      const filePath = path.join(artifactsDir, `${cid}.json`);
      const gzPath = path.join(artifactsDir, `${cid}.json.gz`);

      const bytes = Buffer.from(JSON.stringify(versionedPayload, null, 2));
      fs.writeFileSync(filePath, bytes);
      const gz = zlib.gzipSync(bytes);
      fs.writeFileSync(gzPath, gz);

      const enqueueMetadata = Object.fromEntries(
        Object.entries({
          artifactKind: kind,
          cid,
          schemaVersion: SCHEMA_VERSION,
          contentEncoding: "gzip",
          ...metadata,
        }).map(([key, value]) => [key, String(value ?? "")])
      );

      let synapse;
      if (process.env.FILECOIN_PRIVATE_KEY) {
        queue.enqueue({ cid, kind, gzPath, metadata: enqueueMetadata });
        synapse = { enabled: true, uploaded: false, state: "pending" };
      } else {
        synapse = {
          enabled: false,
          uploaded: false,
          state: "disabled",
          reason: "FILECOIN_PRIVATE_KEY not set",
        };
      }

      const artifact = {
        kind,
        cid,
        schemaVersion: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        localPath: filePath,
        gzPath,
        synapse,
      };

      if (typeof onPersist === "function") {
        try {
          onPersist(artifact, metadata);
        } catch (error) {
          console.error(`[artifacts] onPersist hook failed for ${cid}: ${error.message}`);
        }
      }

      return artifact;
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  createArtifactStore,
  createUploadQueue,
  ensureDir,
  readJson,
  writeJson,
};
