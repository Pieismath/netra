export type Network = "solana-devnet" | "solana-mainnet" | "solana-testnet";

export interface HotspotListing {
  id: string;
  controlApiUrl: string;
  name: string;
  ssid?: string;
  pricePerMinute: number;
  hostWallet?: string;
  network: Network;
  reputation?: number;
  source: "mdns" | "registry";
  raw?: unknown;
}

export interface X402ChallengeExtra {
  reference: string;
  listingId: string;
  minutes: number;
  action?: string;
  sessionId?: string | null;
  tier?: string;
}

export interface X402Challenge {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  amountDisplay?: string;
  payTo: string;
  resource?: string;
  description?: string;
  memo?: string;
  extra: X402ChallengeExtra;
}

export interface X402ChallengeResponse {
  x402Version: number;
  error: string;
  message?: string;
  accepts: X402Challenge[];
  paymentContext?: {
    reference: string;
    expiresAt: string;
    retryHeader: string;
  };
}

export interface PaymentInfo {
  signature: string;
  slot?: number;
  buyerWallet: string;
  transferredLamports: number;
  memoPresent: boolean;
  explorerUrl?: string;
}

export interface Session {
  sessionId: string;
  ip: string;
  listingId: string;
  controlApiUrl: string;
  status: string;
  minutesPurchased: number;
  paidUntil: string;
  amountLamports: number;
  amountSol: string;
  txSignature: string;
  buyerWallet: string;
  paymentReference: string;
  sessionType?: string;
  raw?: unknown;
}

export interface PurchaseResult {
  session: Session;
  payment: PaymentInfo;
  secondsGranted: number;
}

export interface RefundResult {
  refundLamports: number;
  refundSol: string;
  refundStatus: string;
  refundTxHash?: string;
  refundExplorerUrl?: string;
  minutesUsed: number;
  minutesRemaining: number;
  session?: Session;
}

export type DisconnectReason =
  | "manual"
  | "expired"
  | "signal-loss"
  | "error"
  | "budget-exhausted";
