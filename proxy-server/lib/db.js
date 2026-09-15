"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  listing_id TEXT,
  host_id TEXT,
  host_wallet TEXT,
  session_type TEXT,
  tier TEXT,
  entrypoint TEXT,
  buyer_wallet TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  paid_until TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  minutes_purchased REAL NOT NULL DEFAULT 0,
  minutes_used REAL NOT NULL DEFAULT 0,
  bytes_forwarded INTEGER NOT NULL DEFAULT 0,
  amount_lamports INTEGER NOT NULL DEFAULT 0,
  amount_sol REAL NOT NULL DEFAULT 0,
  tx_hash TEXT,
  payment_reference TEXT,
  payment_source TEXT,
  payment_explorer_url TEXT,
  status_transitions_json TEXT NOT NULL DEFAULT '[]',
  refund_json TEXT,
  filecoin_json TEXT NOT NULL DEFAULT '{"latestCid":null,"artifacts":[]}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_ip ON sessions(ip);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_listing ON sessions(listing_id);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ssid TEXT,
  location TEXT,
  description TEXT,
  price_per_minute REAL NOT NULL,
  price_lamports_per_minute INTEGER NOT NULL,
  signal_strength INTEGER,
  status TEXT NOT NULL DEFAULT 'available',
  available INTEGER NOT NULL DEFAULT 1,
  host TEXT,
  host_wallet TEXT,
  host_ip TEXT,
  portal_url TEXT,
  upload_mbps REAL,
  download_mbps REAL,
  demo INTEGER NOT NULL DEFAULT 0,
  is_real INTEGER NOT NULL DEFAULT 0,
  duration_options_json TEXT NOT NULL DEFAULT '[]',
  policies_json TEXT NOT NULL DEFAULT '{}',
  filecoin_json TEXT NOT NULL DEFAULT '{}',
  reputation_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  reference TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  ip TEXT,
  listing_id TEXT,
  buyer_wallet TEXT,
  tier TEXT,
  minutes REAL NOT NULL,
  amount_lamports INTEGER NOT NULL,
  amount_sol REAL NOT NULL,
  pay_to TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  signature TEXT,
  payment_explorer_url TEXT,
  fulfilled_session_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_ip ON intents(ip);

CREATE TABLE IF NOT EXISTS pending_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  destination TEXT,
  amount_lamports INTEGER NOT NULL,
  memo TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  signature TEXT,
  explorer_url TEXT,
  source_wallet TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_refunds_status ON pending_refunds(status);
CREATE INDEX IF NOT EXISTS idx_pending_refunds_session ON pending_refunds(session_id);

CREATE TABLE IF NOT EXISTS artifacts (
  cid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  listing_id TEXT,
  local_path TEXT,
  synapse_status TEXT,
  synapse_attempts INTEGER NOT NULL DEFAULT 0,
  synapse_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_listing ON artifacts(listing_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);

CREATE TABLE IF NOT EXISTS upload_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cid TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT,
  last_error TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY (cid) REFERENCES artifacts(cid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upload_queue_state ON upload_queue(state);
CREATE INDEX IF NOT EXISTS idx_upload_queue_cid ON upload_queue(cid);
`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToSession(row) {
  if (!row) return null;
  return {
    ip: row.ip,
    session_id: row.id,
    listing_id: row.listing_id,
    host_id: row.host_id,
    host_wallet: row.host_wallet,
    session_type: row.session_type,
    tier: row.tier,
    entrypoint: row.entrypoint,
    started_at: row.started_at,
    paid_until: row.paid_until,
    ended_at: row.ended_at,
    minutes_purchased: row.minutes_purchased,
    minutes_used: row.minutes_used,
    bytes_forwarded: row.bytes_forwarded,
    tx_hash: row.tx_hash,
    payment_reference: row.payment_reference,
    payment_source: row.payment_source,
    payment_explorer_url: row.payment_explorer_url,
    buyer_wallet: row.buyer_wallet,
    amount_lamports: row.amount_lamports,
    amount_sol: row.amount_sol,
    status: row.status,
    status_transitions: parseJson(row.status_transitions_json, []),
    refund: parseJson(row.refund_json, null),
    filecoin: parseJson(row.filecoin_json, { latestCid: null, artifacts: [] }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionParams(session) {
  return {
    id: session.session_id,
    ip: session.ip,
    listing_id: session.listing_id ?? null,
    host_id: session.host_id ?? null,
    host_wallet: session.host_wallet ?? null,
    session_type: session.session_type ?? null,
    tier: session.tier ?? null,
    entrypoint: session.entrypoint ?? null,
    buyer_wallet: session.buyer_wallet ?? null,
    status: session.status,
    started_at: session.started_at,
    paid_until: session.paid_until ?? null,
    ended_at: session.ended_at ?? null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    minutes_purchased: Number(session.minutes_purchased || 0),
    minutes_used: Number(session.minutes_used || 0),
    bytes_forwarded: Number(session.bytes_forwarded || 0),
    amount_lamports: Number(session.amount_lamports || 0),
    amount_sol: Number(session.amount_sol || 0),
    tx_hash: session.tx_hash ?? null,
    payment_reference: session.payment_reference ?? null,
    payment_source: session.payment_source ?? null,
    payment_explorer_url: session.payment_explorer_url ?? null,
    status_transitions_json: JSON.stringify(session.status_transitions || []),
    refund_json: session.refund ? JSON.stringify(session.refund) : null,
    filecoin_json: JSON.stringify(session.filecoin || { latestCid: null, artifacts: [] }),
  };
}

function rowToListing(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ssid: row.ssid,
    location: row.location,
    description: row.description ?? undefined,
    pricePerMinute: row.price_per_minute,
    signalStrength: row.signal_strength,
    status: row.status,
    available: Boolean(row.available),
    host: row.host,
    hostWallet: row.host_wallet,
    hostIp: row.host_ip,
    portalUrl: row.portal_url,
    uploadMbps: row.upload_mbps,
    downloadMbps: row.download_mbps,
    demo: Boolean(row.demo),
    real: Boolean(row.is_real),
    durationOptions: parseJson(row.duration_options_json, []),
    policies: parseJson(row.policies_json, {}),
    filecoin: parseJson(row.filecoin_json, {}),
    reputation: parseJson(row.reputation_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listingParams(listing) {
  const lamportsPerMinute = Math.round(Number(listing.pricePerMinute || 0) * 1_000_000_000);
  return {
    id: listing.id,
    name: listing.name,
    ssid: listing.ssid ?? null,
    location: listing.location ?? null,
    description: listing.description ?? null,
    price_per_minute: Number(listing.pricePerMinute || 0),
    price_lamports_per_minute: lamportsPerMinute,
    signal_strength: listing.signalStrength ?? null,
    status: listing.status || "available",
    available: listing.available === false ? 0 : 1,
    host: listing.host ?? null,
    host_wallet: listing.hostWallet ?? null,
    host_ip: listing.hostIp ?? null,
    portal_url: listing.portalUrl ?? null,
    upload_mbps: listing.uploadMbps ?? null,
    download_mbps: listing.downloadMbps ?? null,
    demo: listing.demo ? 1 : 0,
    is_real: listing.real ? 1 : 0,
    duration_options_json: JSON.stringify(listing.durationOptions || []),
    policies_json: JSON.stringify(listing.policies || {}),
    filecoin_json: JSON.stringify(listing.filecoin || {}),
    reputation_json: listing.reputation ? JSON.stringify(listing.reputation) : null,
    created_at: listing.createdAt,
    updated_at: listing.updatedAt,
  };
}

function rowToIntent(row) {
  if (!row) return null;
  return {
    id: row.intent_id,
    action: row.action,
    sessionId: row.session_id,
    ip: row.ip,
    listingId: row.listing_id,
    buyerWallet: row.buyer_wallet,
    tier: row.tier,
    minutes: row.minutes,
    amountLamports: row.amount_lamports,
    amountSol: row.amount_sol,
    reference: row.reference,
    payTo: row.pay_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    txHash: row.signature,
    paymentExplorerUrl: row.payment_explorer_url ?? null,
    fulfilledSessionId: row.fulfilled_session_id ?? null,
    updatedAt: row.updated_at,
  };
}

function intentParams(intent) {
  return {
    reference: intent.reference,
    intent_id: intent.id,
    action: intent.action,
    ip: intent.ip ?? null,
    listing_id: intent.listingId ?? null,
    buyer_wallet: intent.buyerWallet ?? null,
    tier: intent.tier ?? null,
    minutes: Number(intent.minutes || 0),
    amount_lamports: Number(intent.amountLamports || 0),
    amount_sol: Number(intent.amountSol || 0),
    pay_to: intent.payTo,
    status: intent.status,
    session_id: intent.sessionId ?? null,
    signature: intent.txHash ?? null,
    payment_explorer_url: intent.paymentExplorerUrl ?? null,
    fulfilled_session_id: intent.fulfilledSessionId ?? null,
    created_at: intent.createdAt,
    expires_at: intent.expiresAt,
    updated_at: intent.updatedAt ?? null,
  };
}

function rowToPendingRefund(row) {
  if (!row) return null;
  return {
    rowId: row.id,
    sessionId: row.session_id,
    destination: row.destination,
    amountLamports: row.amount_lamports,
    memo: row.memo,
    attempts: row.attempts,
    lastError: row.last_error,
    status: row.status,
    nextAttemptAt: row.next_attempt_at,
    signature: row.signature,
    explorerUrl: row.explorer_url,
    sourceWallet: row.source_wallet,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function pendingRefundParams(entry) {
  return {
    id: entry.rowId ?? null,
    session_id: entry.sessionId,
    destination: entry.destination ?? null,
    amount_lamports: Number(entry.amountLamports || 0),
    memo: entry.memo ?? null,
    attempts: Number(entry.attempts || 0),
    last_error: entry.lastError ?? null,
    status: entry.status || "pending",
    next_attempt_at: Number(entry.nextAttemptAt || 0),
    signature: entry.signature ?? null,
    explorer_url: entry.explorerUrl ?? null,
    source_wallet: entry.sourceWallet ?? null,
    completed_at: entry.completedAt ?? null,
    created_at: entry.createdAt,
  };
}

function openDatabase({ dataDir }) {
  ensureDir(dataDir);
  const dbPath = path.join(dataDir, "netra.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  const stmts = {
    insertSession: db.prepare(`
      INSERT INTO sessions (
        id, ip, listing_id, host_id, host_wallet, session_type, tier, entrypoint,
        buyer_wallet, status, started_at, paid_until, ended_at, created_at, updated_at,
        minutes_purchased, minutes_used, bytes_forwarded, amount_lamports, amount_sol,
        tx_hash, payment_reference, payment_source, payment_explorer_url,
        status_transitions_json, refund_json, filecoin_json
      ) VALUES (
        @id, @ip, @listing_id, @host_id, @host_wallet, @session_type, @tier, @entrypoint,
        @buyer_wallet, @status, @started_at, @paid_until, @ended_at, @created_at, @updated_at,
        @minutes_purchased, @minutes_used, @bytes_forwarded, @amount_lamports, @amount_sol,
        @tx_hash, @payment_reference, @payment_source, @payment_explorer_url,
        @status_transitions_json, @refund_json, @filecoin_json
      )
      ON CONFLICT(id) DO UPDATE SET
        ip = excluded.ip,
        listing_id = excluded.listing_id,
        host_id = excluded.host_id,
        host_wallet = excluded.host_wallet,
        session_type = excluded.session_type,
        tier = excluded.tier,
        entrypoint = excluded.entrypoint,
        buyer_wallet = excluded.buyer_wallet,
        status = excluded.status,
        started_at = excluded.started_at,
        paid_until = excluded.paid_until,
        ended_at = excluded.ended_at,
        updated_at = excluded.updated_at,
        minutes_purchased = excluded.minutes_purchased,
        minutes_used = excluded.minutes_used,
        bytes_forwarded = excluded.bytes_forwarded,
        amount_lamports = excluded.amount_lamports,
        amount_sol = excluded.amount_sol,
        tx_hash = excluded.tx_hash,
        payment_reference = excluded.payment_reference,
        payment_source = excluded.payment_source,
        payment_explorer_url = excluded.payment_explorer_url,
        status_transitions_json = excluded.status_transitions_json,
        refund_json = excluded.refund_json,
        filecoin_json = excluded.filecoin_json
    `),
    selectSessionById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    selectActiveSessionForIp: db.prepare(
      "SELECT * FROM sessions WHERE ip = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
    ),
    selectGatedSessionForIp: db.prepare(
      "SELECT * FROM sessions WHERE ip = ? AND status IN ('active','paid') ORDER BY started_at DESC LIMIT 1"
    ),
    selectSessionsAll: db.prepare("SELECT * FROM sessions ORDER BY started_at DESC"),
    selectExpiredActiveSessions: db.prepare(
      "SELECT * FROM sessions WHERE status = 'active' AND paid_until <= ?"
    ),
    selectSessionsByListing: db.prepare("SELECT * FROM sessions WHERE listing_id = ?"),
    updateSessionBytes: db.prepare(
      "UPDATE sessions SET bytes_forwarded = bytes_forwarded + @bytes, updated_at = @updated_at WHERE id = @id"
    ),

    insertListing: db.prepare(`
      INSERT INTO listings (
        id, name, ssid, location, description, price_per_minute, price_lamports_per_minute,
        signal_strength, status, available, host, host_wallet, host_ip, portal_url,
        upload_mbps, download_mbps, demo, is_real, duration_options_json, policies_json,
        filecoin_json, reputation_json, created_at, updated_at
      ) VALUES (
        @id, @name, @ssid, @location, @description, @price_per_minute, @price_lamports_per_minute,
        @signal_strength, @status, @available, @host, @host_wallet, @host_ip, @portal_url,
        @upload_mbps, @download_mbps, @demo, @is_real, @duration_options_json, @policies_json,
        @filecoin_json, @reputation_json, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        ssid = excluded.ssid,
        location = excluded.location,
        description = excluded.description,
        price_per_minute = excluded.price_per_minute,
        price_lamports_per_minute = excluded.price_lamports_per_minute,
        signal_strength = excluded.signal_strength,
        status = excluded.status,
        available = excluded.available,
        host = excluded.host,
        host_wallet = excluded.host_wallet,
        host_ip = excluded.host_ip,
        portal_url = excluded.portal_url,
        upload_mbps = excluded.upload_mbps,
        download_mbps = excluded.download_mbps,
        demo = excluded.demo,
        is_real = excluded.is_real,
        duration_options_json = excluded.duration_options_json,
        policies_json = excluded.policies_json,
        filecoin_json = excluded.filecoin_json,
        reputation_json = excluded.reputation_json,
        updated_at = excluded.updated_at
    `),
    selectListingById: db.prepare("SELECT * FROM listings WHERE id = ?"),
    selectListingsAll: db.prepare("SELECT * FROM listings ORDER BY created_at DESC"),
    selectFirstListingByCreated: db.prepare("SELECT * FROM listings ORDER BY created_at ASC LIMIT 1"),
    deleteListingById: db.prepare("DELETE FROM listings WHERE id = ?"),
    countListings: db.prepare("SELECT COUNT(*) AS n FROM listings"),

    insertIntent: db.prepare(`
      INSERT INTO intents (
        reference, intent_id, action, ip, listing_id, buyer_wallet, tier, minutes,
        amount_lamports, amount_sol, pay_to, status, session_id, signature,
        payment_explorer_url, fulfilled_session_id,
        created_at, expires_at, updated_at
      ) VALUES (
        @reference, @intent_id, @action, @ip, @listing_id, @buyer_wallet, @tier, @minutes,
        @amount_lamports, @amount_sol, @pay_to, @status, @session_id, @signature,
        @payment_explorer_url, @fulfilled_session_id,
        @created_at, @expires_at, @updated_at
      )
      ON CONFLICT(reference) DO UPDATE SET
        action = excluded.action,
        ip = excluded.ip,
        listing_id = excluded.listing_id,
        buyer_wallet = excluded.buyer_wallet,
        tier = excluded.tier,
        minutes = excluded.minutes,
        amount_lamports = excluded.amount_lamports,
        amount_sol = excluded.amount_sol,
        pay_to = excluded.pay_to,
        status = excluded.status,
        session_id = excluded.session_id,
        signature = excluded.signature,
        payment_explorer_url = excluded.payment_explorer_url,
        fulfilled_session_id = excluded.fulfilled_session_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `),
    selectIntentByReference: db.prepare("SELECT * FROM intents WHERE reference = ?"),
    selectIntentsAll: db.prepare("SELECT * FROM intents ORDER BY created_at DESC"),
    deleteExpiredIntents: db.prepare("DELETE FROM intents WHERE expires_at <= ?"),

    insertPendingRefund: db.prepare(`
      INSERT INTO pending_refunds (
        session_id, destination, amount_lamports, memo, attempts, last_error,
        status, next_attempt_at, signature, explorer_url, source_wallet,
        completed_at, created_at
      ) VALUES (
        @session_id, @destination, @amount_lamports, @memo, @attempts, @last_error,
        @status, @next_attempt_at, @signature, @explorer_url, @source_wallet,
        @completed_at, @created_at
      )
    `),
    updatePendingRefund: db.prepare(`
      UPDATE pending_refunds SET
        attempts = @attempts,
        last_error = @last_error,
        status = @status,
        next_attempt_at = @next_attempt_at,
        signature = @signature,
        explorer_url = @explorer_url,
        source_wallet = @source_wallet,
        completed_at = @completed_at
      WHERE id = @id
    `),
    selectPendingRefundsAll: db.prepare(
      "SELECT * FROM pending_refunds ORDER BY created_at ASC"
    ),
    selectActivePendingRefunds: db.prepare(
      "SELECT * FROM pending_refunds WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id ASC"
    ),

    insertArtifact: db.prepare(`
      INSERT INTO artifacts (cid, kind, session_id, listing_id, local_path,
        synapse_status, synapse_attempts, synapse_json, created_at)
      VALUES (@cid, @kind, @session_id, @listing_id, @local_path,
        @synapse_status, @synapse_attempts, @synapse_json, @created_at)
      ON CONFLICT(cid) DO UPDATE SET
        kind = excluded.kind,
        session_id = excluded.session_id,
        listing_id = excluded.listing_id,
        local_path = excluded.local_path,
        synapse_status = excluded.synapse_status,
        synapse_attempts = excluded.synapse_attempts,
        synapse_json = excluded.synapse_json
    `),
    selectArtifactByCid: db.prepare("SELECT * FROM artifacts WHERE cid = ?"),

    insertUploadQueue: db.prepare(`
      INSERT INTO upload_queue (cid, attempts, last_attempt, last_error, state, created_at)
      VALUES (@cid, @attempts, @last_attempt, @last_error, @state, @created_at)
    `),
    selectUploadQueueByCid: db.prepare(
      "SELECT * FROM upload_queue WHERE cid = ? ORDER BY id DESC LIMIT 1"
    ),
  };

  function upsertSession(session) {
    stmts.insertSession.run(sessionParams(session));
  }

  function upsertListing(listing) {
    stmts.insertListing.run(listingParams(listing));
  }

  function upsertIntent(intent) {
    stmts.insertIntent.run(intentParams(intent));
  }

  function getSessionById(id) {
    return rowToSession(stmts.selectSessionById.get(id));
  }

  function getActiveSessionForIp(ip) {
    return rowToSession(stmts.selectActiveSessionForIp.get(ip));
  }

  function getGatedSessionForIp(ip) {
    return rowToSession(stmts.selectGatedSessionForIp.get(ip));
  }

  function getAllSessions() {
    return stmts.selectSessionsAll.all().map(rowToSession);
  }

  function getExpiredActiveSessions(currentIso) {
    return stmts.selectExpiredActiveSessions.all(currentIso).map(rowToSession);
  }

  function getSessionsByListing(listingId) {
    return stmts.selectSessionsByListing.all(listingId).map(rowToSession);
  }

  function incrementSessionBytes(id, bytes, updatedAt) {
    stmts.updateSessionBytes.run({ id, bytes: Number(bytes || 0), updated_at: updatedAt });
  }

  function getListingById(id) {
    return rowToListing(stmts.selectListingById.get(id));
  }

  function getAllListings() {
    return stmts.selectListingsAll.all().map(rowToListing);
  }

  function getFirstListing() {
    return rowToListing(stmts.selectFirstListingByCreated.get());
  }

  function deleteListing(id) {
    return stmts.deleteListingById.run(id).changes > 0;
  }

  function countListings() {
    return stmts.countListings.get().n;
  }

  function getIntentByReference(reference) {
    return rowToIntent(stmts.selectIntentByReference.get(reference));
  }

  function getAllIntents() {
    return stmts.selectIntentsAll.all().map(rowToIntent);
  }

  function deleteExpiredIntents(currentIso) {
    return stmts.deleteExpiredIntents.run(currentIso).changes;
  }

  function insertPendingRefund(entry) {
    const params = pendingRefundParams(entry);
    delete params.id;
    const info = stmts.insertPendingRefund.run(params);
    return info.lastInsertRowid;
  }

  function updatePendingRefund(entry) {
    if (!entry.rowId) throw new Error("updatePendingRefund requires entry.rowId");
    stmts.updatePendingRefund.run(pendingRefundParams(entry));
  }

  function getAllPendingRefunds() {
    return stmts.selectPendingRefundsAll.all().map(rowToPendingRefund);
  }

  function getDuePendingRefunds(currentMs) {
    return stmts.selectActivePendingRefunds.all(currentMs).map(rowToPendingRefund);
  }

  function recordArtifact({
    cid,
    kind,
    sessionId = null,
    listingId = null,
    localPath = null,
    synapse = null,
    createdAt,
  }) {
    const synapseStatus = synapse
      ? synapse.state || (synapse.uploaded ? "uploaded" : synapse.enabled === false ? "disabled" : "pending")
      : "unknown";
    stmts.insertArtifact.run({
      cid,
      kind,
      session_id: sessionId,
      listing_id: listingId,
      local_path: localPath,
      synapse_status: synapseStatus,
      synapse_attempts: synapse && synapse.uploaded ? 1 : 0,
      synapse_json: synapse ? JSON.stringify(synapse) : null,
      created_at: createdAt,
    });
  }

  function getArtifactByCid(cid) {
    const row = stmts.selectArtifactByCid.get(cid);
    if (!row) return null;
    return {
      cid: row.cid,
      kind: row.kind,
      sessionId: row.session_id,
      listingId: row.listing_id,
      localPath: row.local_path,
      synapseStatus: row.synapse_status,
      synapseAttempts: row.synapse_attempts,
      synapse: parseJson(row.synapse_json, null),
      createdAt: row.created_at,
    };
  }

  function transaction(fn) {
    return db.transaction(fn);
  }

  function close() {
    if (db.open) db.close();
  }

  return {
    db,
    dbPath,
    upsertSession,
    upsertListing,
    upsertIntent,
    getSessionById,
    getActiveSessionForIp,
    getGatedSessionForIp,
    getAllSessions,
    getExpiredActiveSessions,
    getSessionsByListing,
    incrementSessionBytes,
    getListingById,
    getAllListings,
    getFirstListing,
    deleteListing,
    countListings,
    getIntentByReference,
    getAllIntents,
    deleteExpiredIntents,
    insertPendingRefund,
    updatePendingRefund,
    getAllPendingRefunds,
    getDuePendingRefunds,
    recordArtifact,
    getArtifactByCid,
    transaction,
    close,
  };
}

module.exports = {
  openDatabase,
  ensureDir,
};
