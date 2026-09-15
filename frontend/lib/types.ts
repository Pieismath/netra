// ─── Shared type definitions ────────────────────────────────────────────────

/** A hotspot listing shown on the marketplace page. */
export interface HotspotListing {
  id: string;
  name: string;
  ssid?: string;       // WiFi network name the buyer connects to
  location: string;
  pricePerMinute: number;  // SOL
  signalStrength: 1 | 2 | 3 | 4 | 5; // bars
  status: "available" | "occupied";
  host: string; // display handle of host
  hostWallet?: string | null;
  hostIp?: string;     // IP of the host's machine running the captive portal
  portalUrl?: string;  // http://[hostIp]:8888/ — captive portal entry point
  uploadMbps: number;
  downloadMbps: number;
  // TODO(backend): persist `description` and `bandwidthTier` so the host
  // onboarding flow can round-trip them without losing data.
  description?: string;
  bandwidthTier?: "basic" | "standard" | "premium";
  durationOptions?: number[];
  demo?: boolean;
  real?: boolean;
  policies?: {
    noInternetUntilPaid: boolean;
    refundWindowSeconds: number;
    sessionTypeSupport?: string[];
    agentAccess?: boolean;
  };
  reputation?: {
    reliabilityScore: number;
    successfulSessions: number;
    refunds: number;
    disconnectRate: number;
  };
  filecoin?: {
    latestProfileCid?: string;
    latestReputationCid?: string;
    synapse?: {
      enabled?: boolean;
      uploaded?: boolean;
      reason?: string;
      pieceCid?: string;
    };
  };
  updatedAt?: string;
}

/** Session record returned by the proxy control API. */
export interface ProxySession {
  ip: string;
  session_id: string;
  listing_id: string;
  host_id: string;
  host_wallet?: string | null;
  session_type: "human" | "agent";
  tier: string;
  entrypoint: string;
  paid_until: string;        // ISO date string
  ended_at: string | null;
  minutes_purchased: number;
  minutes_used?: number;
  started_at: string;        // ISO date string
  bytes_forwarded: number;
  tx_hash: string | null;
  payment_reference?: string | null;
  payment_source?: string | null;
  payment_explorer_url?: string | null;
  amount_sol?: number;
  amount_lamports?: number;
  buyer_wallet?: string | null;
  status: "payment_pending" | "paid" | "active" | "expired" | "refunded" | "disconnected";
  status_transitions: Array<{
    status: string;
    at: string;
    metadata?: Record<string, unknown>;
  }>;
  refund?: {
    amountLamports: number;
    amountSol: number;
    minutesRemaining: number;
    reason: string;
    status?: string;
    txHash?: string | null;
    explorerUrl?: string | null;
    sourceWallet?: string | null;
    error?: string | null;
  } | null;
  filecoin: {
    latestCid: string | null;
    artifacts: Array<{
      kind: string;
      cid: string;
      createdAt: string;
      localPath: string;
      synapse?: {
        enabled?: boolean;
        uploaded?: boolean;
        network?: string;
        pieceCid?: string;
        reason?: string;
      };
    }>;
  };
  active: boolean;
  seconds_remaining: number;
}

/** Result of DELETE /sessions/:ip (early exit). */
export interface EarlyExitResult {
  minutes_used: number;
  minutes_remaining: number;
  refund_amount: number;
  refund_lamports?: number;
  refund_status?: string;
  refund_tx_hash?: string | null;
  refund_explorer_url?: string | null;
  refund_error?: string | null;
  session: ProxySession;
}

export interface DashboardData {
  summary: {
    totalListings: number;
    activeSessions: number;
    completedSessions: number;
    totalEarnedSol: number;
    refunds: number;
  };
  listings: HotspotListing[];
  sessions: ProxySession[];
  recentArtifacts: Array<{
    sessionId: string;
    listingId: string;
    kind: string;
    cid: string;
    createdAt: string;
    synapse?: {
      enabled?: boolean;
      uploaded?: boolean;
      network?: string;
      pieceCid?: string;
      reason?: string;
    };
  }>;
}
