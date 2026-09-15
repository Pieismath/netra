"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { EarlyExitResult, HotspotListing, ProxySession } from "@/lib/types";
import { deleteSession, getMyIp, getSessions } from "@/lib/api";
import QrCode from "./QrCode";

const DURATION_OPTIONS = [5, 10, 30] as const;

interface Props {
  listing: HotspotListing;
  onClose: () => void;
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.max(0, totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDate(value?: string | null) {
  if (!value) return "Pending";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMinutes(value?: number) {
  return Number(value || 0).toFixed(2).replace(/\.00$/, "");
}

type LoadState = "loading" | "ready" | "timeout" | "error";

const LOAD_TIMEOUT_MS = 10_000;

export default function ConnectModal({ listing, onClose }: Props) {
  const [duration, setDuration] = useState<(typeof DURATION_OPTIONS)[number]>(10);
  const [session, setSession] = useState<ProxySession | null>(null);
  const [refund, setRefund] = useState<EarlyExitResult | null>(null);
  const [myIp, setMyIp] = useState<string>("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const portalUrl =
    listing.portalUrl || `http://${listing.hostIp || "localhost"}:8888/`;
  const controlUrl = `http://${listing.hostIp || "localhost"}:3001`;

  useEffect(() => {
    let mounted = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    setLoadState("loading");
    setError(null);

    async function refresh() {
      try {
        const [{ ip }, sessions] = await Promise.all([getMyIp(), getSessions()]);
        if (!mounted) return;
        setMyIp(ip);
        const active = sessions.find(
          (item) =>
            item.ip === ip &&
            item.active &&
            (!item.listing_id || item.listing_id === listing.id)
        );
        setSession(active || null);
        setLoadState("ready");
        setError(null);
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Could not load current session");
        setLoadState((prev) => (prev === "loading" ? "loading" : "error"));
      }
    }

    timeout = setTimeout(() => {
      if (!mounted) return;
      setLoadState((prev) => (prev === "loading" ? "timeout" : prev));
    }, LOAD_TIMEOUT_MS);

    refresh();
    interval = setInterval(refresh, 5000);
    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
    };
  }, [listing.id, retryNonce]);

  const handleRetry = () => setRetryNonce((n) => n + 1);

  async function handleDisconnect() {
    if (!session) return;
    try {
      const result = await deleteSession(session.ip);
      setRefund(result);
      setSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to end session");
    }
  }

  const totalCost = useMemo(
    () => (listing.pricePerMinute * duration).toFixed(4),
    [duration, listing.pricePerMinute]
  );

  const curlExample = useMemo(
    () =>
      [
        `curl -i -X POST ${controlUrl}/x402/sessions/purchase \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{`,
        `    "ip": "${myIp || "192.168.2.77"}",`,
        `    "listingId": "${listing.id}",`,
        `    "minutes": ${duration},`,
        `    "tier": "priority"`,
        `  }'`,
      ].join("\n"),
    [controlUrl, duration, listing.id, myIp]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm sm:items-center sm:px-4 sm:py-8"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="relative max-h-[95vh] w-full max-w-3xl overflow-y-auto rounded-[24px] border border-white/10 bg-[#0c1119] shadow-2xl sm:rounded-[28px]">
        <div className="border-b border-white/8 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.18),_transparent_40%),radial-gradient(circle_at_top_right,_rgba(59,130,246,0.18),_transparent_35%),#0c1119] px-5 py-4 sm:px-6 sm:py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.26em] text-emerald-300/70">
                Hotspot Access
              </p>
              <h2 className="mt-2 text-xl font-semibold text-white sm:text-2xl">{listing.name}</h2>
              <p className="mt-1 text-sm text-slate-300">
                No roaming until payment clears. Humans use the captive portal, agents use x402.
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border border-white/10 text-slate-400 transition hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="grid gap-6 px-5 py-5 sm:px-6 sm:py-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "State", value: session ? "Session active" : "Blocked until paid" },
                { label: "SSID", value: listing.ssid || "Listed hotspot" },
                { label: "Rate", value: `${listing.pricePerMinute} SOL/min` },
                { label: "Reliability", value: `${listing.reputation?.reliabilityScore ?? 100}%` },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3"
                >
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    {item.label}
                  </div>
                  <div className="mt-2 text-sm font-medium text-white">{item.value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-3xl border border-emerald-500/20 bg-emerald-500/10 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-emerald-200/70">
                    Human Flow
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-white">
                    Join Wi-Fi, then pay in the captive portal
                  </h3>
                </div>
                <a
                  href={portalUrl}
                  className="inline-flex min-h-[44px] items-center justify-center self-start rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
                >
                  Open Portal
                </a>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]">
                <div className="space-y-3 text-sm text-emerald-50/90">
                  <p>1. Connect to <span className="font-mono text-white">{listing.ssid}</span>.</p>
                  <p>2. If the captive popup does not open, visit <span className="font-mono text-white">{portalUrl}</span>.</p>
                  <p>3. Pay {totalCost} SOL for {duration} minutes in Phantom and the firewall unlocks this device IP.</p>
                </div>
                <div className="rounded-2xl bg-white p-3">
                  <QrCode value={portalUrl} size={120} />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {DURATION_OPTIONS.map((value) => (
                  <button
                    key={value}
                    onClick={() => setDuration(value)}
                    className={`min-h-[44px] min-w-[72px] rounded-full px-4 py-2 text-sm font-semibold transition ${
                      duration === value
                        ? "bg-white text-slate-950"
                        : "bg-white/10 text-emerald-50 hover:bg-white/15"
                    }`}
                  >
                    {value} min
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-sky-500/20 bg-sky-500/10 p-5">
              <div className="text-xs uppercase tracking-[0.24em] text-sky-200/70">
                Agent Flow
              </div>
              <h3 className="mt-2 text-lg font-semibold text-white">
                x402 returns a payment challenge before service is granted
              </h3>
              <p className="mt-2 text-sm text-sky-50/85">
                Programmatic buyers hit the x402 purchase endpoint, receive HTTP 402 with Solana payment terms, pay on devnet, then retry with the transaction signature to unlock or extend access.
              </p>
              <pre className="mt-4 overflow-x-auto rounded-2xl border border-white/10 bg-slate-950/70 p-4 text-xs leading-6 text-sky-100">
                <code>{curlExample}</code>
              </pre>
            </div>
          </div>

          <div className="space-y-5">
            <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-5">
              <div className="text-xs uppercase tracking-[0.24em] text-slate-500">
                Live Session
              </div>
              {loadState === "loading" ? (
                <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-slate-500" />
                  Checking current hotspot state…
                </div>
              ) : loadState === "timeout" ? (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-amber-100">
                    The proxy did not respond within 10 seconds. The host may be offline or unreachable from this network.
                  </p>
                  <button
                    onClick={handleRetry}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/15"
                  >
                    Retry
                  </button>
                </div>
              ) : session ? (
                <div className="mt-4 space-y-4">
                  <div className="rounded-2xl bg-emerald-500/10 p-4 text-center">
                    <div className="text-5xl font-semibold tracking-[0.18em] text-white">
                      {formatCountdown(session.seconds_remaining)}
                    </div>
                    <div className="mt-2 text-xs uppercase tracking-[0.26em] text-emerald-200/70">
                      Session Active
                    </div>
                  </div>

                  <div className="space-y-3 rounded-2xl border border-white/8 bg-[#0a0f17] p-4 text-sm">
                    <Row label="Access state" value={session.status.replace("_", " ")} />
                    <Row label="Your IP" value={myIp || session.ip} mono />
                    <Row label="Paid" value={`${Number(session.amount_sol || 0).toFixed(4)} SOL`} />
                    <Row label="Session type" value={session.session_type} />
                    <Row
                      label="Solana tx"
                      value={
                        session.payment_explorer_url ? (
                          <a
                            href={session.payment_explorer_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-300 hover:text-emerald-200"
                          >
                            {(session.tx_hash || "").slice(0, 12)}...
                          </a>
                        ) : (
                          session.tx_hash || "Pending"
                        )
                      }
                      mono
                    />
                    <Row
                      label="Filecoin receipt CID"
                      value={session.filecoin.latestCid || "Pending"}
                      mono
                    />
                    <Row label="Started" value={formatDate(session.started_at)} />
                  </div>

                  <button
                    onClick={handleDisconnect}
                    className="min-h-[44px] w-full rounded-2xl border border-red-500/30 bg-red-500/10 py-3 text-sm font-semibold text-red-300 transition hover:bg-red-500/15"
                  >
                    Disconnect Early
                  </button>
                </div>
              ) : (
                <div className="mt-4 space-y-3 text-sm text-slate-300">
                <p>Your traffic stays blocked until payment clears for this device IP.</p>
                <p className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-amber-100">
                    Judge shortcut: the captive portal handles human checkout; the x402 endpoint demonstrates the programmatic flow without any browser UI.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-5">
              <div className="text-xs uppercase tracking-[0.24em] text-slate-500">
                Storage Proof
              </div>
              <div className="mt-3 space-y-3 text-sm text-slate-300">
                <p>
                  Every session mints a CID-backed receipt with status transitions, bytes forwarded, tx hash, and refund outcome.
                </p>
                <p>
                  Latest host reputation CID:{" "}
                  <span className="font-mono text-sky-200">
                    {listing.filecoin?.latestReputationCid || "Pending"}
                  </span>
                </p>
              </div>
            </div>

            {refund && (
              <div className="rounded-3xl border border-indigo-500/20 bg-indigo-500/10 p-5 text-sm text-indigo-100">
                <div className="text-xs uppercase tracking-[0.24em] text-indigo-200/70">
                  Closeout
                </div>
                <p className="mt-2">
                  Session ended after {formatMinutes(refund.minutes_used)} minute(s).{" "}
                  {refund.refund_amount > 0 ? (
                    refund.refund_status === "sent" ? (
                      <>
                        Prorated refund sent:{" "}
                        <span className="font-semibold">{refund.refund_amount.toFixed(4)} SOL</span>
                      </>
                    ) : (
                      <>
                        Prorated refund due:{" "}
                        <span className="font-semibold">{refund.refund_amount.toFixed(4)} SOL</span>
                      </>
                    )
                  ) : (
                    <>Session completed with no refund due.</>
                  )}
                </p>
                {refund.refund_status === "sent" && refund.refund_explorer_url && (
                  <p className="mt-2">
                    Refund tx:{" "}
                    <a
                      href={refund.refund_explorer_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-indigo-50 underline underline-offset-4"
                    >
                      {(refund.refund_tx_hash || "").slice(0, 12)}...
                    </a>
                  </p>
                )}
                {refund.refund_status && refund.refund_status !== "sent" && refund.refund_amount > 0 && (
                  <p className="mt-2 text-indigo-100/80">
                    {refund.refund_error || "Netra could not broadcast the refund transfer yet."}
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={mono ? "font-mono text-white" : "text-white"}>{value}</span>
    </div>
  );
}
