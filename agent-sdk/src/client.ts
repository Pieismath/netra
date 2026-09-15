import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import * as os from "os";
import type { HttpClient, HttpResponse } from "./http";
import { AxiosHttpClient, joinUrl } from "./http";
import { discover } from "./discovery";
import { SolanaPayer, type Payer } from "./solana-payer";
import type {
  HotspotListing,
  PurchaseResult,
  RefundResult,
  Session,
  X402ChallengeResponse,
} from "./types";

export interface NetraClientOptions {
  wallet: Keypair;
  controlApiUrl?: string;
  rpcUrl?: string;
  ip?: string;
  tier?: string;
  registryUrls?: string[];
  enableMdns?: boolean;
  mdnsTimeoutMs?: number;
  http?: HttpClient;
  payer?: Payer;
  connection?: Connection;
}

interface RawSessionPayload {
  ip: string;
  session_id: string;
  listing_id: string;
  status: string;
  minutes_purchased: number;
  paid_until: string;
  amount_lamports: number;
  amount_sol: string;
  buyer_wallet: string;
  tx_hash: string;
  payment_reference: string;
  session_type?: string;
}

interface RawPurchaseResponse {
  ok: boolean;
  payment: {
    signature: string;
    slot?: number;
    buyerWallet: string;
    transferredLamports: number;
    memoPresent: boolean;
    explorerUrl?: string;
  };
  session: RawSessionPayload;
  seconds_granted: number;
}

interface RawRefundResponse {
  minutes_used: number;
  minutes_remaining: number;
  refund_amount?: string;
  refund_lamports: number;
  refund_status: string;
  refund_tx_hash?: string;
  refund_explorer_url?: string;
  session?: RawSessionPayload;
}

function detectLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "127.0.0.1";
}

function buildSession(
  raw: RawSessionPayload,
  controlApiUrl: string
): Session {
  return {
    sessionId: raw.session_id,
    ip: raw.ip,
    listingId: raw.listing_id,
    controlApiUrl,
    status: raw.status,
    minutesPurchased: raw.minutes_purchased,
    paidUntil: raw.paid_until,
    amountLamports: raw.amount_lamports,
    amountSol: raw.amount_sol,
    txSignature: raw.tx_hash,
    buyerWallet: raw.buyer_wallet,
    paymentReference: raw.payment_reference,
    sessionType: raw.session_type,
    raw,
  };
}

export class NetraClient {
  readonly wallet: Keypair;
  readonly buyerWallet: string;
  readonly defaultControlApiUrl?: string;
  readonly tier: string;
  readonly ip: string;
  private readonly http: HttpClient;
  private readonly payer: Payer;
  private readonly registryUrls: string[];
  private readonly enableMdns: boolean;
  private readonly mdnsTimeoutMs: number;
  private session: Session | null = null;
  private knownListings = new Map<string, HotspotListing>();

  constructor(opts: NetraClientOptions) {
    this.wallet = opts.wallet;
    this.buyerWallet = opts.wallet.publicKey.toBase58();
    this.defaultControlApiUrl = opts.controlApiUrl;
    this.tier = opts.tier ?? "standard";
    this.ip = opts.ip ?? detectLocalIp();
    this.http = opts.http ?? new AxiosHttpClient();
    this.registryUrls = opts.registryUrls ?? [];
    this.enableMdns = opts.enableMdns !== false;
    this.mdnsTimeoutMs = opts.mdnsTimeoutMs ?? 2000;

    if (opts.payer) {
      this.payer = opts.payer;
    } else {
      const connection =
        opts.connection ??
        new Connection(opts.rpcUrl ?? clusterApiUrl("devnet"), "confirmed");
      this.payer = new SolanaPayer(connection);
    }
  }

  get currentSession(): Session | null {
    return this.session;
  }

  setCurrentSession(session: Session | null): void {
    this.session = session;
  }

  async discover(): Promise<HotspotListing[]> {
    const registryUrls = this.registryUrls.length
      ? this.registryUrls
      : this.defaultControlApiUrl
      ? [this.defaultControlApiUrl]
      : [];

    const listings = await discover({
      registryUrls,
      enableMdns: this.enableMdns,
      mdnsTimeoutMs: this.mdnsTimeoutMs,
      http: this.http,
    });
    this.knownListings = new Map(listings.map((l) => [l.id, l]));
    return listings;
  }

  private resolveControlApiUrl(
    listingId: string,
    listings?: HotspotListing[]
  ): { controlApiUrl: string; listing?: HotspotListing } {
    if (listings) {
      for (const l of listings) {
        if (l.id === listingId) return { controlApiUrl: l.controlApiUrl, listing: l };
      }
    }
    const known = this.knownListings.get(listingId);
    if (known) return { controlApiUrl: known.controlApiUrl, listing: known };
    if (this.defaultControlApiUrl)
      return { controlApiUrl: this.defaultControlApiUrl };
    throw new Error(
      `Unknown listing "${listingId}" and no controlApiUrl configured. Call discover() first or pass listings explicitly.`
    );
  }

  async purchase(
    listingId: string,
    minutes: number,
    listings?: HotspotListing[]
  ): Promise<PurchaseResult> {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(`minutes must be a positive number, got ${minutes}`);
    }
    const { controlApiUrl } = this.resolveControlApiUrl(listingId, listings);
    const url = joinUrl(controlApiUrl, "/x402/sessions/purchase");
    return this.runX402Flow(url, controlApiUrl, listingId, minutes);
  }

  async extend(sessionId: string, minutes: number): Promise<PurchaseResult> {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(`minutes must be a positive number, got ${minutes}`);
    }
    const session = this.session;
    if (!session || session.sessionId !== sessionId) {
      throw new Error(
        `extend(${sessionId}) called but currentSession is ${
          session ? session.sessionId : "null"
        }. Call purchase first or set currentSession.`
      );
    }
    const url = joinUrl(
      session.controlApiUrl,
      `/x402/sessions/${sessionId}/extend`
    );
    return this.runX402Flow(url, session.controlApiUrl, session.listingId, minutes);
  }

  async disconnect(sessionId: string): Promise<RefundResult> {
    const session = this.session;
    if (!session || session.sessionId !== sessionId) {
      throw new Error(
        `disconnect(${sessionId}) called but currentSession is ${
          session ? session.sessionId : "null"
        }.`
      );
    }
    const url = joinUrl(session.controlApiUrl, `/sessions/${session.ip}`);
    const res = await this.http.delete<RawRefundResponse>(url);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `disconnect failed: ${res.status} ${JSON.stringify(res.data)}`
      );
    }
    const data = res.data;
    const refund: RefundResult = {
      refundLamports: data.refund_lamports,
      refundSol:
        data.refund_amount ??
        (data.refund_lamports / 1_000_000_000).toString(),
      refundStatus: data.refund_status,
      refundTxHash: data.refund_tx_hash,
      refundExplorerUrl: data.refund_explorer_url,
      minutesUsed: data.minutes_used,
      minutesRemaining: data.minutes_remaining,
      session: data.session
        ? buildSession(data.session, session.controlApiUrl)
        : undefined,
    };
    this.session = null;
    return refund;
  }

  private async runX402Flow(
    url: string,
    controlApiUrl: string,
    listingId: string,
    minutes: number
  ): Promise<PurchaseResult> {
    const baseBody = {
      ip: this.ip,
      minutes,
      listingId,
      buyerWallet: this.buyerWallet,
      tier: this.tier,
    };

    const challengeRes = (await this.http.post(
      url,
      baseBody
    )) as HttpResponse<X402ChallengeResponse>;

    if (challengeRes.status !== 402) {
      throw new Error(
        `Expected HTTP 402, received ${challengeRes.status}: ${JSON.stringify(
          challengeRes.data
        )}`
      );
    }
    const challenge = challengeRes.data?.accepts?.[0];
    if (!challenge) {
      throw new Error(
        `402 response missing accepts[0]: ${JSON.stringify(challengeRes.data)}`
      );
    }
    const reference =
      challenge.extra?.reference ?? challengeRes.data?.paymentContext?.reference;
    if (!reference) {
      throw new Error(
        `402 response missing payment reference: ${JSON.stringify(
          challengeRes.data
        )}`
      );
    }

    const signature = await this.payer.signAndSend(challenge, this.wallet);

    const finalizeRes = (await this.http.post(
      url,
      { ...baseBody, reference },
      { "Payment-Signature": signature }
    )) as HttpResponse<RawPurchaseResponse>;

    if (finalizeRes.status < 200 || finalizeRes.status >= 300) {
      throw new Error(
        `Payment finalize failed: ${finalizeRes.status} ${JSON.stringify(
          finalizeRes.data
        )}`
      );
    }
    const data = finalizeRes.data;
    if (!data?.session) {
      throw new Error(
        `Finalize response missing session: ${JSON.stringify(data)}`
      );
    }
    const session = buildSession(data.session, controlApiUrl);
    this.session = session;
    return {
      session,
      payment: data.payment,
      secondsGranted: data.seconds_granted,
    };
  }
}
