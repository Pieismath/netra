import { EventEmitter } from "events";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NetraClient, type NetraClientOptions } from "./client";
import type {
  DisconnectReason,
  HotspotListing,
  Session,
} from "./types";

export interface ConnectionManagerOptions extends NetraClientOptions {
  maxBudgetSol: number;
  sessionMinutes: number;
  refundDestination?: string;
  signalThreshold?: number;
  pollIntervalMs?: number;
  extendLeadSeconds?: number;
  getSignalStrength?: () => Promise<number> | number;
  client?: NetraClient;
}

type State = "idle" | "discovering" | "purchasing" | "connected" | "stopped";

export interface ConnectionManagerEvents {
  connected: (session: Session) => void;
  disconnected: (reason: DisconnectReason, error?: Error) => void;
  "budget-exhausted": (spentLamports: number, limitLamports: number) => void;
  "no-hotspots-found": () => void;
  error: (error: Error) => void;
}

export interface ConnectionManager {
  on<E extends keyof ConnectionManagerEvents>(
    event: E,
    listener: ConnectionManagerEvents[E]
  ): this;
  off<E extends keyof ConnectionManagerEvents>(
    event: E,
    listener: ConnectionManagerEvents[E]
  ): this;
  emit<E extends keyof ConnectionManagerEvents>(
    event: E,
    ...args: Parameters<ConnectionManagerEvents[E]>
  ): boolean;
}

export class ConnectionManager extends EventEmitter {
  private readonly client: NetraClient;
  private readonly maxBudgetLamports: number;
  private readonly sessionMinutes: number;
  private readonly signalThreshold: number;
  private readonly pollIntervalMs: number;
  private readonly extendLeadSeconds: number;
  private readonly getSignalStrength: () => Promise<number> | number;

  private state: State = "idle";
  private busy = false;
  private totalSpentLamports = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private extendTimer: NodeJS.Timeout | null = null;

  constructor(opts: ConnectionManagerOptions) {
    super();
    this.client = opts.client ?? new NetraClient(opts);
    this.maxBudgetLamports = Math.floor(opts.maxBudgetSol * LAMPORTS_PER_SOL);
    this.sessionMinutes = opts.sessionMinutes;
    this.signalThreshold = opts.signalThreshold ?? 0.3;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.extendLeadSeconds = opts.extendLeadSeconds ?? 30;
    this.getSignalStrength = opts.getSignalStrength ?? (() => 1.0);
  }

  get currentSession(): Session | null {
    return this.client.currentSession;
  }

  get spentLamports(): number {
    return this.totalSpentLamports;
  }

  async start(): Promise<void> {
    if (this.state === "stopped") {
      throw new Error("ConnectionManager has been stopped; create a new one.");
    }
    if (this.pollTimer) return;
    await this.tick();
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.extendTimer) {
      clearTimeout(this.extendTimer);
      this.extendTimer = null;
    }
    const session = this.client.currentSession;
    if (session) {
      try {
        await this.client.disconnect(session.sessionId);
      } catch (err) {
        this.emit("error", err as Error);
      }
    }
    this.state = "stopped";
    this.emit("disconnected", "manual");
  }

  private async tick(): Promise<void> {
    if (this.busy || this.state === "stopped") return;
    this.busy = true;
    try {
      const signal = await this.getSignalStrength();
      const session = this.client.currentSession;

      if (!session) {
        await this.discoverAndConnect();
        return;
      }
      if (signal < this.signalThreshold) {
        await this.handleSignalLoss();
        return;
      }
      const remainingMs = new Date(session.paidUntil).getTime() - Date.now();
      if (remainingMs <= 0) {
        this.emit("disconnected", "expired");
        this.client.setCurrentSession(null);
        await this.discoverAndConnect();
      }
    } catch (err) {
      this.emit("error", err as Error);
    } finally {
      this.busy = false;
    }
  }

  private async discoverAndConnect(): Promise<void> {
    this.state = "discovering";
    let listings: HotspotListing[];
    try {
      listings = await this.client.discover();
    } catch (err) {
      this.emit("error", err as Error);
      this.state = "idle";
      return;
    }

    const remainingBudget = this.maxBudgetLamports - this.totalSpentLamports;
    const affordable = listings
      .filter((l) => {
        const cost = Math.floor(l.pricePerMinute * this.sessionMinutes * LAMPORTS_PER_SOL);
        return cost <= remainingBudget;
      })
      .sort((a, b) => {
        if (a.pricePerMinute !== b.pricePerMinute)
          return a.pricePerMinute - b.pricePerMinute;
        return (b.reputation ?? 0) - (a.reputation ?? 0);
      });

    if (affordable.length === 0) {
      if (listings.length === 0) {
        this.emit("no-hotspots-found");
      } else {
        this.emit("budget-exhausted", this.totalSpentLamports, this.maxBudgetLamports);
      }
      this.state = "idle";
      return;
    }

    const pick = affordable[0];
    await this.purchaseListing(pick, listings);
  }

  private async purchaseListing(
    pick: HotspotListing,
    listings: HotspotListing[]
  ): Promise<void> {
    const projected = Math.floor(
      pick.pricePerMinute * this.sessionMinutes * LAMPORTS_PER_SOL
    );
    if (this.totalSpentLamports + projected > this.maxBudgetLamports) {
      this.emit("budget-exhausted", this.totalSpentLamports, this.maxBudgetLamports);
      this.state = "idle";
      return;
    }

    this.state = "purchasing";
    try {
      const result = await this.client.purchase(
        pick.id,
        this.sessionMinutes,
        listings
      );
      this.totalSpentLamports += result.session.amountLamports;
      this.scheduleExtend(result.session);
      this.state = "connected";
      this.emit("connected", result.session);
    } catch (err) {
      this.state = "idle";
      this.emit("error", err as Error);
    }
  }

  private scheduleExtend(session: Session): void {
    if (this.extendTimer) {
      clearTimeout(this.extendTimer);
      this.extendTimer = null;
    }
    const paidUntilMs = new Date(session.paidUntil).getTime();
    const fireAt = paidUntilMs - this.extendLeadSeconds * 1000;
    const delay = Math.max(0, fireAt - Date.now());
    this.extendTimer = setTimeout(() => {
      void this.attemptExtend();
    }, delay);
  }

  private async attemptExtend(): Promise<void> {
    if (this.busy || this.state === "stopped") {
      this.extendTimer = setTimeout(() => void this.attemptExtend(), 1000);
      return;
    }
    this.busy = true;
    try {
      const session = this.client.currentSession;
      if (!session) return;

      const projected = this.estimateExtendLamports(session);
      if (this.totalSpentLamports + projected > this.maxBudgetLamports) {
        this.emit("budget-exhausted", this.totalSpentLamports, this.maxBudgetLamports);
        return;
      }
      const result = await this.client.extend(session.sessionId, this.sessionMinutes);
      this.totalSpentLamports += result.payment.transferredLamports;
      this.scheduleExtend(result.session);
      this.emit("connected", result.session);
    } catch (err) {
      this.emit("error", err as Error);
      this.emit("disconnected", "expired", err as Error);
      this.client.setCurrentSession(null);
    } finally {
      this.busy = false;
    }
  }

  private estimateExtendLamports(session: Session): number {
    const perMinute = session.amountLamports / Math.max(1, session.minutesPurchased);
    return Math.floor(perMinute * this.sessionMinutes);
  }

  private async handleSignalLoss(): Promise<void> {
    const session = this.client.currentSession;
    if (!session) return;
    if (this.extendTimer) {
      clearTimeout(this.extendTimer);
      this.extendTimer = null;
    }
    try {
      const refund = await this.client.disconnect(session.sessionId);
      if (refund.refundLamports > 0) {
        this.totalSpentLamports = Math.max(
          0,
          this.totalSpentLamports - refund.refundLamports
        );
      }
    } catch (err) {
      this.emit("error", err as Error);
    }
    this.client.setCurrentSession(null);
    this.state = "idle";
    this.emit("disconnected", "signal-loss");
    await this.discoverAndConnect();
  }
}
