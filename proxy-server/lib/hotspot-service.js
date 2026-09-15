"use strict";

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const { createArtifactStore } = require("./artifacts");
const { openDatabase } = require("./db");
const { migrateLegacyJson } = require("./db-migrations");
const {
  LAMPORTS_PER_SOL,
  formatSol,
  generateReference,
  normalizeWallet,
  sendSolanaRefund,
  verifySolanaPayment,
} = require("./solana");

function normalizeIp(value) {
  return String(value || "")
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "") || "127.0.0.1";
}

function redactIdentifier(value) {
  if (!value) return "anonymous";
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function normalizeSSID(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  const withoutPrefix = trimmed
    .replace(/^⚡\s*/u, "")
    .replace(/^Netra[-\s]*/i, "")
    .replace(/^HDX[-\s]*/i, "")
    .replace(/^hotspotdex[-\s]*/i, "");

  const slug = withoutPrefix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return slug ? `⚡Netra-${slug}` : "";
}

function sortNewestFirst(items, key = "createdAt") {
  return [...items].sort((a, b) => new Date(b[key] || 0) - new Date(a[key] || 0));
}

const DEMO_HOTSPOTS = [
  {
    id: "demo-fishtown-commons",
    name: "Fishtown Commons",
    ssid: "⚡Netra-Fishtown",
    location: "Philadelphia, PA · Fishtown",
    pricePerMinute: 0.001,
    signalStrength: 5,
    uploadMbps: 45,
    downloadMbps: 180,
    host: "demo-host-fishtown",
    demo: true,
    durationOptions: [5, 10, 30],
  },
  {
    id: "demo-old-city-relay",
    name: "Old City Relay",
    ssid: "⚡Netra-OldCity",
    location: "Philadelphia, PA · Old City",
    pricePerMinute: 0.0008,
    signalStrength: 4,
    uploadMbps: 30,
    downloadMbps: 120,
    host: "demo-host-oldcity",
    demo: true,
    durationOptions: [10, 20, 30],
  },
  {
    id: "demo-university-city-mesh",
    name: "University City Mesh",
    ssid: "⚡Netra-UCity",
    location: "Philadelphia, PA · University City",
    pricePerMinute: 0.0012,
    signalStrength: 3,
    uploadMbps: 28,
    downloadMbps: 90,
    host: "demo-host-ucity",
    demo: true,
    durationOptions: [5, 15, 30],
  },
  {
    id: "demo-riverfront-ap",
    name: "Riverfront AP",
    ssid: "⚡Netra-Riverfront",
    location: "Philadelphia, PA · Penn's Landing",
    pricePerMinute: 0.0006,
    signalStrength: 4,
    uploadMbps: 32,
    downloadMbps: 110,
    host: "demo-host-riverfront",
    demo: true,
    durationOptions: [5, 10, 20],
  },
];

function createHotspotService({
  dataDir,
  verifyPayment = verifySolanaPayment,
  sendRefund = sendSolanaRefund,
  now = () => Date.now(),
  localIp = "localhost",
  hostWallet = process.env.SOLANA_WALLET || null,
  ratePerMinute = Number(process.env.RATE_PER_MIN || 0.001),
  portalPort = Number(process.env.PORTAL_PORT || 8888),
}) {
  const store = openDatabase({ dataDir });
  const artifactStore = createArtifactStore({
    dataDir,
    onPersist: (artifact, metadata) => {
      store.recordArtifact({
        cid: artifact.cid,
        kind: artifact.kind,
        sessionId: metadata?.sessionId ?? null,
        listingId: metadata?.listingId ?? null,
        localPath: artifact.localPath,
        synapse: artifact.synapse,
        createdAt: artifact.createdAt,
      });
    },
  });

  migrateLegacyJson({
    dataDir,
    store,
    log: (msg) => console.log(`[netra-db] ${msg}`),
  });

  const REFUND_MAX_ATTEMPTS = 5;
  const REFUND_INITIAL_BACKOFF_MS = 30_000;

  const extensionMutexes = new Map();
  // The session ledger keeps one canonical JS object per session_id so concurrent
  // callers see each other's mutations the same way the old in-memory state did.
  const sessionInstances = new Map();

  function withSessionLock(sessionId, fn) {
    const previous = extensionMutexes.get(sessionId) || Promise.resolve();
    const current = previous.then(fn, fn);
    const tracker = current.catch(() => {});
    extensionMutexes.set(sessionId, tracker);
    tracker.then(() => {
      if (extensionMutexes.get(sessionId) === tracker) {
        extensionMutexes.delete(sessionId);
      }
    });
    return current;
  }

  function ts(value = now()) {
    return new Date(value).toISOString();
  }

  function bindSession(row) {
    if (!row) return null;
    const cached = sessionInstances.get(row.session_id);
    if (!cached) {
      sessionInstances.set(row.session_id, row);
      return row;
    }
    if (new Date(row.updatedAt).getTime() > new Date(cached.updatedAt).getTime()) {
      for (const key of Object.keys(row)) cached[key] = row[key];
    }
    return cached;
  }

  function persistSession(session) {
    store.upsertSession(session);
    sessionInstances.set(session.session_id, session);
  }

  function getActiveSessionForIp(ip) {
    const row = store.getActiveSessionForIp(ip);
    if (!row) return null;
    if (new Date(row.paid_until).getTime() <= now()) return null;
    return bindSession(row);
  }

  function getSessionById(id) {
    const row = store.getSessionById(id);
    return bindSession(row);
  }

  function pickListing(listingId) {
    if (listingId) {
      const direct = store.getListingById(listingId);
      if (direct) return direct;
    }
    const fallback = store.getFirstListing();
    if (fallback) return fallback;
    return createDefaultListing();
  }

  function createDefaultListing() {
    const existing = store.getListingById("local-hotspot");
    if (existing) return existing;

    const listing = {
      id: "local-hotspot",
      name: process.env.HOTSPOT_NAME || "Netra Test Account",
      ssid: normalizeSSID(process.env.HOTSPOT_SSID || "Netra Test Account"),
      location: process.env.HOTSPOT_LOCATION || "Philadelphia, PA · Demo hotspot",
      pricePerMinute: ratePerMinute,
      signalStrength: Number(process.env.HOTSPOT_SIGNAL || 4),
      status: "available",
      host: process.env.HOST_HANDLE || "Netra Test Account",
      hostWallet: normalizeWallet(hostWallet),
      hostIp: localIp,
      portalUrl: `http://${localIp}:${portalPort}/`,
      uploadMbps: Number(process.env.HOTSPOT_UP || 50),
      downloadMbps: Number(process.env.HOTSPOT_DOWN || 100),
      durationOptions: [5, 10, 30],
      demo: false,
      real: true,
      policies: {
        noInternetUntilPaid: true,
        refundWindowSeconds: Number(process.env.HOTSPOT_REFUND_WINDOW || 30),
        sessionTypeSupport: ["human", "agent"],
      },
      filecoin: {},
      createdAt: ts(),
      updatedAt: ts(),
    };

    store.upsertListing(listing);
    return listing;
  }

  function ensureDemoListings() {
    for (const demo of DEMO_HOTSPOTS) {
      const existing = store.getListingById(demo.id);
      if (existing) {
        existing.demo = true;
        existing.durationOptions = demo.durationOptions;
        store.upsertListing(existing);
        continue;
      }

      const listing = {
        ...demo,
        ssid: normalizeSSID(demo.ssid || demo.name),
        status: "available",
        hostWallet: normalizeWallet(hostWallet),
        hostIp: localIp,
        portalUrl: `http://${localIp}:${portalPort}/`,
        policies: {
          noInternetUntilPaid: true,
          refundWindowSeconds: Number(process.env.HOTSPOT_REFUND_WINDOW || 30),
          sessionTypeSupport: ["human", "agent"],
          agentAccess: true,
        },
        filecoin: {},
        real: false,
        createdAt: ts(),
        updatedAt: ts(),
      };
      store.upsertListing(listing);
    }
  }

  function addTransition(session, status, metadata = {}) {
    session.status = status;
    session.status_transitions.push({
      status,
      at: ts(),
      metadata,
    });
  }

  async function refreshListingArtifacts(listing) {
    const related = store.getSessionsByListing(listing.id);
    const completed = related.filter((session) => ["expired", "disconnected", "refunded"].includes(session.status));
    const refunded = related.filter((session) => session.status === "refunded");
    const uptimeScore = completed.length
      ? Math.max(0, 100 - Math.round((refunded.length / completed.length) * 100))
      : 100;

    const profilePayload = {
      listingId: listing.id,
      name: listing.name,
      ssid: listing.ssid,
      location: listing.location,
      pricing: {
        ratePerMinuteSol: listing.pricePerMinute,
      },
      policies: listing.policies,
      aggregateUsage: {
        totalSessions: related.length,
        activeSessions: related.filter((session) => session.status === "active").length,
        completedSessions: completed.length,
        bytesForwarded: related.reduce((sum, session) => sum + (session.bytes_forwarded || 0), 0),
      },
      updatedAt: ts(),
    };

    const reputationPayload = {
      listingId: listing.id,
      hostWallet: listing.hostWallet,
      successfulSessions: completed.length - refunded.length,
      refunds: refunded.length,
      disconnectRate: completed.length ? refunded.length / completed.length : 0,
      slaFailures: refunded.length,
      reliabilityScore: uptimeScore,
      updatedAt: ts(),
    };

    const profileArtifact = await artifactStore.persist("host-profile", profilePayload, {
      listingId: listing.id,
      scope: "profile",
    });
    const reputationArtifact = await artifactStore.persist("reputation", reputationPayload, {
      listingId: listing.id,
      scope: "reputation",
    });

    listing.filecoin = {
      latestProfileCid: profileArtifact.cid,
      latestReputationCid: reputationArtifact.cid,
      synapse: reputationArtifact.synapse,
    };
    listing.reputation = {
      reliabilityScore: uptimeScore,
      successfulSessions: reputationPayload.successfulSessions,
      refunds: reputationPayload.refunds,
      disconnectRate: reputationPayload.disconnectRate,
    };
    listing.updatedAt = ts();
    store.upsertListing(listing);
  }

  async function persistSessionArtifact(session, artifactKind, extra = {}) {
    const payload = {
      artifactKind,
      sessionId: session.session_id,
      listingId: session.listing_id,
      hostId: session.host_id,
      hostWallet: session.host_wallet,
      buyer: {
        redactedIp: redactIdentifier(session.ip),
        redactedWallet: redactIdentifier(session.buyer_wallet),
        sessionType: session.session_type,
      },
      time: {
        startedAt: session.started_at,
        paidUntil: session.paid_until,
        endedAt: session.ended_at || null,
      },
      usage: {
        minutesPurchased: session.minutes_purchased,
        minutesUsed: session.minutes_used || 0,
        bytesForwarded: session.bytes_forwarded || 0,
      },
      payment: {
        txHash: session.tx_hash,
        reference: session.payment_reference,
        amountSol: session.amount_sol,
        amountLamports: session.amount_lamports,
        explorerUrl: session.payment_explorer_url,
        source: session.payment_source,
      },
      refund: session.refund || null,
      status: session.status,
      statusTransitions: session.status_transitions,
      extra,
      generatedAt: ts(),
    };

    const artifact = await artifactStore.persist(artifactKind, payload, {
      sessionId: session.session_id,
      listingId: session.listing_id,
    });

    if (!session.filecoin) session.filecoin = { latestCid: null, artifacts: [] };
    session.filecoin.latestCid = artifact.cid;
    session.filecoin.artifacts.push(artifact);
    return artifact;
  }

  async function upsertListing(input) {
    const normalized = {
      id: input.id || `hs-${Date.now()}`,
      name: input.name,
      ssid: normalizeSSID(input.ssid || input.name),
      location: input.location || "Unknown location",
      pricePerMinute: Number(input.pricePerMinute || ratePerMinute),
      signalStrength: Number(input.signalStrength || 4),
      status: "available",
      host: input.host || "host",
      hostWallet: normalizeWallet(input.hostWallet || hostWallet),
      hostIp: input.hostIp || localIp,
      portalUrl: input.portalUrl || `http://${input.hostIp || localIp}:${portalPort}/`,
      uploadMbps: Number(input.uploadMbps || 50),
      downloadMbps: Number(input.downloadMbps || 100),
      durationOptions: Array.isArray(input.durationOptions) && input.durationOptions.length
        ? input.durationOptions.map((value) => Number(value)).filter(Boolean)
        : [5, 10, 30],
      demo: Boolean(input.demo),
      policies: {
        noInternetUntilPaid: true,
        refundWindowSeconds: Number(input.refundWindowSeconds || process.env.HOTSPOT_REFUND_WINDOW || 30),
        agentAccess: true,
      },
      filecoin: input.filecoin || {},
      createdAt: input.createdAt || ts(),
      updatedAt: ts(),
    };

    const existing = store.getListingById(normalized.id);
    const merged = existing ? { ...existing, ...normalized } : normalized;
    store.upsertListing(merged);
    await refreshListingArtifacts(merged);
    return merged;
  }

  async function createSession({
    ip,
    minutes,
    txHash,
    paymentReference,
    paymentSource,
    paymentExplorerUrl,
    listingId,
    sessionType,
    buyerWallet,
    tier = "standard",
    source = "captive-portal",
  }) {
    const cleanIp = normalizeIp(ip);
    const listing = pickListing(listingId);
    const start = now();
    const paidUntil = start + Number(minutes) * 60 * 1000;
    const amountLamports = Math.round(
      Number(listing.pricePerMinute || ratePerMinute) * Number(minutes) * LAMPORTS_PER_SOL
    );

    const existing = getActiveSessionForIp(cleanIp);
    if (existing) {
      return withSessionLock(existing.session_id, async () => {
        // Pull latest committed state from DB and merge into the cached
        // reference so this fn sees prior fns' increments while keeping the
        // same JS object identity for waiting callers.
        const latest = store.getSessionById(existing.session_id);
        if (latest && new Date(latest.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
          for (const key of Object.keys(latest)) existing[key] = latest[key];
        }

        existing.minutes_purchased += Number(minutes);
        existing.paid_until = ts(new Date(existing.paid_until).getTime() + Number(minutes) * 60 * 1000);
        existing.amount_lamports += amountLamports;
        existing.amount_sol = formatSol(existing.amount_lamports);
        existing.tx_hash = txHash || existing.tx_hash;
        existing.payment_reference = paymentReference || existing.payment_reference;
        existing.payment_explorer_url = paymentExplorerUrl || existing.payment_explorer_url;
        existing.updatedAt = ts();
        addTransition(existing, "active", {
          reason: "extended",
          addedMinutes: Number(minutes),
          source,
        });
        persistSession(existing);
        await persistSessionArtifact(existing, "session-extension", { addedMinutes: Number(minutes) });
        persistSession(existing);
        await refreshListingArtifacts(listing);
        return existing;
      });
    }

    const session = {
      ip: cleanIp,
      session_id: uuidv4(),
      listing_id: listing.id,
      host_id: listing.id,
      host_wallet: listing.hostWallet,
      session_type: sessionType,
      tier,
      entrypoint: source,
      started_at: ts(start),
      paid_until: ts(paidUntil),
      ended_at: null,
      minutes_purchased: Number(minutes),
      minutes_used: 0,
      bytes_forwarded: 0,
      tx_hash: txHash || null,
      payment_reference: paymentReference || null,
      payment_source: paymentSource,
      payment_explorer_url: paymentExplorerUrl || null,
      buyer_wallet: buyerWallet || null,
      amount_lamports: amountLamports,
      amount_sol: formatSol(amountLamports),
      status: "payment_pending",
      status_transitions: [],
      refund: null,
      filecoin: {
        latestCid: null,
        artifacts: [],
      },
      createdAt: ts(start),
      updatedAt: ts(start),
    };

    addTransition(session, "paid", {
      source,
      txHash: txHash || null,
    });
    addTransition(session, "active", {
      source,
      sessionType,
    });

    persistSession(session);
    await persistSessionArtifact(session, "session-receipt", { source });
    persistSession(session);
    await refreshListingArtifacts(listing);
    return session;
  }

  function buildIntent({ ip, minutes, listingId, buyerWallet, tier, action, sessionId }) {
    if (!minutes || Number(minutes) <= 0) {
      throw new Error("minutes must be a positive number");
    }
    const listing = pickListing(listingId);
    const wallet = normalizeWallet(listing.hostWallet || hostWallet);
    if (!wallet) {
      throw new Error("SOLANA_WALLET or listing host wallet must be configured");
    }

    const amountLamports = Math.round(
      Number(listing.pricePerMinute || ratePerMinute) * Number(minutes) * LAMPORTS_PER_SOL
    );
    const reference = generateReference();
    const intent = {
      id: `intent-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      action,
      sessionId: sessionId || null,
      ip: normalizeIp(ip),
      listingId: listing.id,
      buyerWallet: buyerWallet || null,
      tier: tier || "standard",
      minutes: Number(minutes),
      amountLamports,
      amountSol: formatSol(amountLamports),
      reference,
      payTo: wallet,
      createdAt: ts(),
      expiresAt: ts(now() + 15 * 60 * 1000),
      status: "pending",
      txHash: null,
      paymentExplorerUrl: null,
      fulfilledSessionId: null,
      updatedAt: null,
    };

    store.upsertIntent(intent);
    return intent;
  }

  function buildX402Challenge(intent, resource, description) {
    return {
      x402Version: 1,
      error: "payment_required",
      message: "Pay on Solana devnet to unlock hotspot access.",
      accepts: [
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: "SOL",
          amount: String(intent.amountLamports),
          amountDisplay: `${intent.amountSol.toFixed(6)} SOL`,
          payTo: intent.payTo,
          resource,
          description,
          memo: `netra:${intent.reference}`,
          extra: {
            reference: intent.reference,
            listingId: intent.listingId,
            minutes: intent.minutes,
            action: intent.action,
            sessionId: intent.sessionId,
            tier: intent.tier,
          },
        },
      ],
      paymentContext: {
        reference: intent.reference,
        expiresAt: intent.expiresAt,
        retryHeader: "Payment-Signature",
      },
    };
  }

  function listSessions() {
    const current = now();
    return store.getAllSessions().map((row) => {
      const session = bindSession(row);
      const paidUntil = new Date(session.paid_until).getTime();
      const active = session.status === "active" && paidUntil > current;
      return {
        ...session,
        active,
        seconds_remaining: active ? Math.max(0, Math.floor((paidUntil - current) / 1000)) : 0,
      };
    });
  }

  async function expireSessions() {
    const expired = store.getExpiredActiveSessions(ts());
    if (expired.length === 0) return;

    for (const row of expired) {
      const session = bindSession(row);
      session.ended_at = ts();
      session.minutes_used = session.minutes_purchased;
      session.updatedAt = ts();
      addTransition(session, "expired", { reason: "time_elapsed" });
      persistSession(session);
      await persistSessionArtifact(session, "session-closeout", { reason: "expired" });
      persistSession(session);
      const listing = pickListing(session.listing_id);
      await refreshListingArtifacts(listing);
    }
  }

  async function disconnectSessionByIp(ip, reason = "manual_disconnect") {
    const cleanIp = normalizeIp(ip);
    const row = store.getGatedSessionForIp(cleanIp);
    if (!row) return null;
    const session = bindSession(row);

    const elapsedMs = Math.max(0, now() - new Date(session.started_at).getTime());
    const purchasedMs = Math.max(1, Number(session.minutes_purchased || 0) * 60 * 1000);
    const clampedElapsedMs = Math.min(elapsedMs, purchasedMs);
    const totalLamports = Math.max(
      0,
      Number(session.amount_lamports || 0) ||
        Math.round(
          Number(session.minutes_purchased || 0) *
            Number(pickListing(session.listing_id).pricePerMinute || ratePerMinute) *
            LAMPORTS_PER_SOL
        )
    );
    const usedLamports = Math.min(
      totalLamports,
      Math.round((clampedElapsedMs / purchasedMs) * totalLamports)
    );
    const refundLamports = Math.max(0, totalLamports - usedLamports);
    const minutesUsed = Number((clampedElapsedMs / 60000).toFixed(2));
    const minutesRemaining = Number(
      Math.max(0, (purchasedMs - clampedElapsedMs) / 60000).toFixed(2)
    );
    let refundResult = {
      status: refundLamports > 0 ? "pending_config" : "not_needed",
      signature: null,
      explorerUrl: null,
      sourceWallet: null,
      error: null,
    };

    if (refundLamports > 0) {
      try {
        refundResult = {
          ...refundResult,
          ...(await sendRefund({
            destination: session.buyer_wallet,
            amountLamports: refundLamports,
            memo: `netra-refund:${session.session_id}`,
          })),
        };
      } catch (error) {
        refundResult = {
          ...refundResult,
          status: "failed",
          error: error.message,
        };
        store.insertPendingRefund({
          sessionId: session.session_id,
          destination: session.buyer_wallet,
          amountLamports: refundLamports,
          memo: `netra-refund:${session.session_id}`,
          attempts: 1,
          lastError: error.message,
          status: "pending",
          nextAttemptAt: now() + REFUND_INITIAL_BACKOFF_MS,
          createdAt: ts(),
        });
      }
    }

    session.minutes_used = minutesUsed;
    session.ended_at = ts();
    session.paid_until = ts(now());
    session.updatedAt = ts();
    session.refund = {
      amountLamports: refundLamports,
      amountSol: formatSol(refundLamports),
      minutesRemaining,
      reason,
      status: refundResult.status,
      txHash: refundResult.signature || null,
      explorerUrl: refundResult.explorerUrl || null,
      sourceWallet: refundResult.sourceWallet || null,
      error: refundResult.error || null,
    };
    const refundCompleted = refundLamports > 0 && refundResult.status === "sent";
    addTransition(session, refundCompleted ? "refunded" : "disconnected", {
      reason,
      minutesUsed,
      minutesRemaining,
      refundStatus: refundResult.status,
      refundTxHash: refundResult.signature || null,
    });

    persistSession(session);
    await persistSessionArtifact(session, "session-closeout", {
      reason,
      minutesUsed,
      minutesRemaining,
      refundStatus: refundResult.status,
    });
    persistSession(session);
    await refreshListingArtifacts(pickListing(session.listing_id));

    return {
      minutes_used: minutesUsed,
      minutes_remaining: minutesRemaining,
      refund_amount: formatSol(refundLamports),
      refund_lamports: refundLamports,
      refund_status: refundResult.status,
      refund_tx_hash: refundResult.signature || null,
      refund_explorer_url: refundResult.explorerUrl || null,
      refund_error: refundResult.error || null,
      session,
    };
  }

  function recordForwardedBytes(ip, bytes) {
    const cleanIp = normalizeIp(ip);
    const session = getActiveSessionForIp(cleanIp);
    if (!session) return;
    store.incrementSessionBytes(session.session_id, bytes, ts());
  }

  async function processPendingRefunds() {
    const due = store.getDuePendingRefunds(now());
    if (due.length === 0) return;

    for (const entry of due) {
      try {
        const result = await sendRefund({
          destination: entry.destination,
          amountLamports: entry.amountLamports,
          memo: entry.memo,
        });
        entry.attempts += 1;
        entry.status = "sent";
        entry.completedAt = ts();
        entry.signature = result.signature || null;
        entry.explorerUrl = result.explorerUrl || null;
        entry.sourceWallet = result.sourceWallet || null;
        entry.lastError = null;
        store.updatePendingRefund(entry);

        const session = getSessionById(entry.sessionId);
        if (session && session.refund) {
          session.refund.status = "sent";
          session.refund.txHash = result.signature || null;
          session.refund.explorerUrl = result.explorerUrl || null;
          session.refund.sourceWallet = result.sourceWallet || null;
          session.refund.error = null;
          addTransition(session, "refunded", {
            reason: "retry_succeeded",
            attempt: entry.attempts,
          });
          session.updatedAt = ts();
          persistSession(session);
        }
      } catch (error) {
        entry.attempts += 1;
        entry.lastError = error.message;
        if (entry.attempts >= REFUND_MAX_ATTEMPTS) {
          entry.status = "permanently_failed";
          const session = getSessionById(entry.sessionId);
          if (session && session.refund) {
            session.refund.status = "permanently_failed";
            session.refund.error = error.message;
            session.updatedAt = ts();
            persistSession(session);
          }
          console.error(
            `[refund] permanently failed for session ${entry.sessionId} after ${entry.attempts} attempts: ${error.message}`
          );
        } else {
          const backoff = REFUND_INITIAL_BACKOFF_MS * Math.pow(2, entry.attempts - 1);
          entry.nextAttemptAt = now() + backoff;
        }
        store.updatePendingRefund(entry);
      }
    }
  }

  function listPendingRefunds() {
    return store.getAllPendingRefunds().map(({ rowId, ...rest }) => rest);
  }

  function removeListing(id) {
    return store.deleteListing(id);
  }

  function pruneIntents() {
    store.deleteExpiredIntents(ts());
  }

  async function fulfillIntent({ reference, signature, buyerWallet }) {
    pruneIntents();
    const intent = store.getIntentByReference(reference);
    if (!intent) {
      throw new Error("Unknown or expired payment reference");
    }

    if (intent.status === "paid" && intent.fulfilledSessionId) {
      const existingSession = getSessionById(intent.fulfilledSessionId);
      if (existingSession) {
        const payment = {
          signature: intent.txHash,
          buyerWallet: intent.buyerWallet,
          explorerUrl: intent.paymentExplorerUrl || null,
          reference,
        };
        return { intent, payment, session: existingSession };
      }
    }

    const payment = await verifyPayment({
      signature,
      reference,
      destination: intent.payTo,
      amountLamports: intent.amountLamports,
    });

    intent.status = "paid";
    intent.buyerWallet = buyerWallet || payment.buyerWallet;
    intent.txHash = signature;
    intent.paymentExplorerUrl = payment.explorerUrl || null;
    intent.updatedAt = ts();
    store.upsertIntent(intent);

    if (intent.action === "purchase") {
      const session = await createSession({
        ip: intent.ip,
        minutes: intent.minutes,
        txHash: signature,
        paymentReference: reference,
        paymentSource: "x402",
        paymentExplorerUrl: payment.explorerUrl,
        listingId: intent.listingId,
        sessionType: "agent",
        buyerWallet: intent.buyerWallet,
        tier: intent.tier,
        source: "x402-api",
      });
      intent.fulfilledSessionId = session.session_id;
      store.upsertIntent(intent);
      return { intent, payment, session };
    }

    const current = getSessionById(intent.sessionId);
    if (!current) {
      throw new Error("Session to extend was not found");
    }

    const session = await createSession({
      ip: current.ip,
      minutes: intent.minutes,
      txHash: signature,
      paymentReference: reference,
      paymentSource: "x402",
      paymentExplorerUrl: payment.explorerUrl,
      listingId: current.listing_id,
      sessionType: current.session_type,
      buyerWallet: intent.buyerWallet,
      tier: intent.tier,
      source: "x402-api",
    });
    intent.fulfilledSessionId = session.session_id;
    store.upsertIntent(intent);
    return { intent, payment, session };
  }

  function getDashboard() {
    const sessions = listSessions();
    const listings = store.getAllListings();
    const active = sessions.filter((session) => session.active);
    const completed = sessions.filter((session) => !session.active);
    const refunded = sessions.filter((session) => session.status === "refunded");
    const totalEarnedSol = sessions.reduce((sum, session) => {
      const refund = session.refund?.amountSol || 0;
      return sum + Number(session.amount_sol || 0) - refund;
    }, 0);

    return {
      summary: {
        totalListings: listings.length,
        activeSessions: active.length,
        completedSessions: completed.length,
        totalEarnedSol,
        refunds: refunded.length,
      },
      listings: sortNewestFirst(listings),
      sessions,
      recentArtifacts: sessions
        .flatMap((session) => (session.filecoin?.artifacts || []).map((artifact) => ({
          sessionId: session.session_id,
          listingId: session.listing_id,
          kind: artifact.kind,
          cid: artifact.cid,
          createdAt: artifact.createdAt,
          synapse: artifact.synapse,
        })))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 8),
    };
  }

  function getHealth() {
    const sessions = listSessions();
    return {
      status: "ok",
      active_sessions: sessions.filter((session) => session.active).length,
      total_sessions: sessions.length,
      total_listings: store.getAllListings().length,
      x402_ready: Boolean(normalizeWallet(hostWallet)),
      filecoin_synapse_ready: Boolean(process.env.FILECOIN_PRIVATE_KEY),
      uptime_seconds: Math.floor(process.uptime()),
    };
  }

  function close() {
    if (typeof artifactStore.stopUploadWorker === "function") {
      artifactStore.stopUploadWorker();
    }
    store.close();
  }

  createDefaultListing();
  ensureDemoListings();

  return {
    buildIntent,
    buildX402Challenge,
    close,
    createDefaultListing,
    createSession,
    disconnectSessionByIp,
    expireSessions,
    fulfillIntent,
    getActiveSessionForIp,
    getDashboard,
    getHealth,
    listListings: () => sortNewestFirst(store.getAllListings()),
    listPendingRefunds,
    listSessions,
    normalizeIp,
    pickListing,
    processPendingRefunds,
    pruneIntents,
    recordForwardedBytes,
    removeListing,
    upsertListing,
  };
}

module.exports = {
  createHotspotService,
  normalizeIp,
  normalizeSSID,
  redactIdentifier,
};
