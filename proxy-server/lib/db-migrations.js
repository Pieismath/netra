"use strict";

const fs = require("fs");
const path = require("path");

const SESSIONS_FILE = "sessions.json";
const LISTINGS_FILE = "listings.json";
const INTENTS_FILE = "payment-intents.json";
const PENDING_REFUNDS_FILE = "pending-refunds.json";

function readJsonFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function dbIsEmpty(store) {
  if (store.countListings() > 0) return false;
  if (store.getAllSessions().length > 0) return false;
  if (store.getAllIntents().length > 0) return false;
  if (store.getAllPendingRefunds().length > 0) return false;
  return true;
}

function ensureSessionShape(raw) {
  if (!raw || !raw.session_id) return null;
  const fallbackArtifacts = { latestCid: null, artifacts: [] };
  return {
    ...raw,
    status_transitions: Array.isArray(raw.status_transitions) ? raw.status_transitions : [],
    refund: raw.refund ?? null,
    filecoin: raw.filecoin && typeof raw.filecoin === "object" ? raw.filecoin : fallbackArtifacts,
    createdAt: raw.createdAt || raw.started_at,
    updatedAt: raw.updatedAt || raw.started_at,
  };
}

function ensureListingShape(raw) {
  if (!raw || !raw.id) return null;
  return {
    ...raw,
    status: raw.status || "available",
    available: raw.available !== false,
    durationOptions: Array.isArray(raw.durationOptions) ? raw.durationOptions : [5, 10, 30],
    policies: raw.policies && typeof raw.policies === "object" ? raw.policies : {},
    filecoin: raw.filecoin && typeof raw.filecoin === "object" ? raw.filecoin : {},
    reputation: raw.reputation ?? null,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
  };
}

function ensureIntentShape(raw) {
  if (!raw || !raw.reference) return null;
  return {
    ...raw,
    status: raw.status || "pending",
  };
}

function ensurePendingRefundShape(raw) {
  if (!raw || !raw.sessionId) return null;
  return {
    sessionId: raw.sessionId,
    destination: raw.destination ?? null,
    amountLamports: Number(raw.amountLamports || 0),
    memo: raw.memo ?? null,
    attempts: Number(raw.attempts || 0),
    lastError: raw.lastError ?? null,
    status: raw.status || "pending",
    nextAttemptAt: Number(raw.nextAttemptAt || 0),
    signature: raw.signature ?? null,
    explorerUrl: raw.explorerUrl ?? null,
    sourceWallet: raw.sourceWallet ?? null,
    completedAt: raw.completedAt ?? null,
    createdAt: raw.createdAt || new Date().toISOString(),
  };
}

function migrateLegacyJson({ dataDir, store, log = () => {} }) {
  const sessionsPath = path.join(dataDir, SESSIONS_FILE);
  const listingsPath = path.join(dataDir, LISTINGS_FILE);
  const intentsPath = path.join(dataDir, INTENTS_FILE);
  const pendingRefundsPath = path.join(dataDir, PENDING_REFUNDS_FILE);

  const hasLegacy = [sessionsPath, listingsPath, intentsPath, pendingRefundsPath].some(
    (p) => fs.existsSync(p)
  );
  if (!hasLegacy) return { migrated: false, reason: "no-legacy-files" };

  if (!dbIsEmpty(store)) {
    return { migrated: false, reason: "db-not-empty" };
  }

  const sessions = (readJsonFile(sessionsPath) || []).map(ensureSessionShape).filter(Boolean);
  const listings = (readJsonFile(listingsPath) || []).map(ensureListingShape).filter(Boolean);
  const intents = (readJsonFile(intentsPath) || []).map(ensureIntentShape).filter(Boolean);
  const pendingRefunds = (readJsonFile(pendingRefundsPath) || [])
    .map(ensurePendingRefundShape)
    .filter(Boolean);

  const total =
    sessions.length + listings.length + intents.length + pendingRefunds.length;
  if (total === 0) {
    return { migrated: false, reason: "legacy-files-empty" };
  }

  const importAll = store.transaction(() => {
    for (const listing of listings) store.upsertListing(listing);
    for (const session of sessions) store.upsertSession(session);
    for (const intent of intents) store.upsertIntent(intent);
    for (const refund of pendingRefunds) store.insertPendingRefund(refund);
  });
  importAll();

  for (const filePath of [sessionsPath, listingsPath, intentsPath, pendingRefundsPath]) {
    if (fs.existsSync(filePath)) {
      const archived = `${filePath}.migrated`;
      try {
        fs.renameSync(filePath, archived);
      } catch (error) {
        log(`failed to archive ${filePath}: ${error.message}`);
      }
    }
  }

  log(
    `migrated legacy JSON state into SQLite — sessions=${sessions.length} listings=${listings.length} intents=${intents.length} pendingRefunds=${pendingRefunds.length}`
  );

  return {
    migrated: true,
    counts: {
      sessions: sessions.length,
      listings: listings.length,
      intents: intents.length,
      pendingRefunds: pendingRefunds.length,
    },
  };
}

module.exports = {
  migrateLegacyJson,
};
