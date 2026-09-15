"use client";

/**
 * /host/earnings — Cross-hotspot earnings view.
 *
 * Aggregates payments across every listing tied to the connected wallet,
 * with toggleable 7d / 30d charts and a recent payouts list.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getDashboard, getHostListings } from "@/lib/api";
import type { DashboardData, HotspotListing, ProxySession } from "@/lib/types";
import WalletButton from "@/components/WalletButton";
import { useWallet, shortenAddress } from "@/lib/wallet";

type Range = "7d" | "30d";

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EarningsPage() {
  const { publicKey } = useWallet();
  const [listings, setListings] = useState<HotspotListing[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("7d");

  useEffect(() => {
    if (!publicKey) {
      setListings([]);
      setDashboard(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([getHostListings(publicKey), getDashboard()])
      .then(([hostListings, dash]) => {
        if (cancelled) return;
        setListings(hostListings);
        setDashboard(dash);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load earnings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const myListingIds = useMemo(() => new Set(listings.map((l) => l.id)), [listings]);
  const mySessions = useMemo<ProxySession[]>(
    () => (dashboard?.sessions ?? []).filter((s) => myListingIds.has(s.listing_id)),
    [dashboard, myListingIds]
  );

  const totals = useMemo(() => {
    const lifetime = mySessions.reduce((sum, s) => sum + (s.amount_sol ?? 0), 0);
    const last7 = sumRecent(mySessions, 7);
    const last30 = sumRecent(mySessions, 30);
    return { lifetime, last7, last30 };
  }, [mySessions]);

  const dailySeries = useMemo(
    () => buildDailySeries(mySessions, range === "7d" ? 7 : 30),
    [mySessions, range]
  );

  const recentPayouts = useMemo(
    () =>
      mySessions
        .filter((s) => (s.amount_sol ?? 0) > 0)
        .slice()
        .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
        .slice(0, 12),
    [mySessions]
  );

  if (!publicKey) {
    return <NotConnected />;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <header className="overflow-hidden rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.18),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(168,159,242,0.18),_transparent_35%),linear-gradient(180deg,#0b1220,#090d15)] px-6 py-8 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-emerald-200/70">Earnings</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              All payouts to {shortenAddress(publicKey)}
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              {listings.length === 0
                ? "Once your hotspots earn, the rollups land here."
                : `${listings.length} hotspot${listings.length === 1 ? "" : "s"} contributing to this wallet.`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <WalletButton variant="compact" />
            <Link
              href="/host"
              className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs text-slate-200 transition hover:bg-white/10"
            >
              ← Host console
            </Link>
          </div>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <BigStat label="Lifetime" value={`${totals.lifetime.toFixed(4)} SOL`} hint="Across all hotspots" />
          <BigStat label="Last 7 days" value={`${totals.last7.toFixed(4)} SOL`} hint={`${countRecent(mySessions, 7)} sessions`} />
          <BigStat label="Last 30 days" value={`${totals.last30.toFixed(4)} SOL`} hint={`${countRecent(mySessions, 30)} sessions`} />
        </div>
      </header>

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="rounded-[28px] border border-white/8 bg-[#0d1420] p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Earnings over time</h2>
            <p className="mt-1 text-sm text-slate-500">
              {loading ? "Loading session data…" : "Daily SOL aggregated from paid sessions."}
            </p>
          </div>
          <div className="inline-flex rounded-full border border-white/10 bg-white/[0.04] p-1 text-xs">
            {(["7d", "30d"] as Range[]).map((opt) => (
              <button
                key={opt}
                onClick={() => setRange(opt)}
                className={`rounded-full px-3 py-1.5 font-semibold transition ${
                  range === opt
                    ? "bg-emerald-400 text-slate-950"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                {opt === "7d" ? "Last 7d" : "Last 30d"}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 h-72">
          {dailySeries.some((d) => d.earned > 0) ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailySeries}>
                <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                <XAxis dataKey="label" stroke="#475569" fontSize={11} tickLine={false} />
                <YAxis stroke="#475569" fontSize={11} tickLine={false} width={56} />
                <Tooltip
                  contentStyle={{
                    background: "#0b1220",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#e2e8f0" }}
                  itemStyle={{ color: "#34d399" }}
                  formatter={(value) => [`${Number(value ?? 0).toFixed(4)} SOL`, "Earned"]}
                />
                <Line
                  type="monotone"
                  dataKey="earned"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={{ r: 3, stroke: "#34d399", fill: "#0b1220" }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              No paid sessions in this range yet.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-[28px] border border-white/8 bg-[#0d1420] p-6">
        <h2 className="text-lg font-semibold text-white">Recent payouts</h2>
        <p className="mt-1 text-sm text-slate-500">
          {/* TODO(backend): expose explicit payout records (refund-adjusted) so this isn't reconstructed from sessions. */}
          Reconstructed from session amounts; refunds reduce the per-session figure shown here.
        </p>
        <div className="mt-4 overflow-hidden rounded-2xl border border-white/8">
          <table className="min-w-full divide-y divide-white/8 text-sm">
            <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Hotspot</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Earned</th>
                <th className="px-4 py-3 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/8 bg-[#091019] text-slate-200">
              {recentPayouts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                    No payouts yet. Add a hotspot from the host console to start earning.
                  </td>
                </tr>
              ) : (
                recentPayouts.map((s) => {
                  const listing = listings.find((l) => l.id === s.listing_id);
                  return (
                    <tr key={s.session_id}>
                      <td className="px-4 py-3 text-xs text-slate-300">{fmtDate(s.started_at)}</td>
                      <td className="px-4 py-3 text-xs">
                        {listing ? (
                          <Link
                            href={`/host/${encodeURIComponent(listing.id)}`}
                            className="text-emerald-300 hover:text-emerald-200"
                          >
                            {listing.name}
                          </Link>
                        ) : (
                          <span className="text-slate-500">{s.listing_id}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">{s.session_type === "agent" ? "x402" : "Portal"}</td>
                      <td className="px-4 py-3 text-xs text-emerald-300">
                        {(s.amount_sol ?? 0).toFixed(4)} SOL
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {s.payment_explorer_url && s.tx_hash ? (
                          <a
                            href={s.payment_explorer_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-300 hover:text-sky-200"
                          >
                            {s.tx_hash.slice(0, 10)}…
                          </a>
                        ) : (
                          <span className="text-slate-500">{s.tx_hash ? `${s.tx_hash.slice(0, 10)}…` : "Pending"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function NotConnected() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-8 text-center">
        <h1 className="text-2xl font-semibold text-white">Connect a wallet to see earnings</h1>
        <p className="mt-2 text-sm text-slate-400">
          Earnings are scoped to the host wallet that owns the listings.
        </p>
        <div className="mt-6 flex justify-center">
          <WalletButton />
        </div>
        <Link
          href="/host"
          className="mt-4 inline-block text-sm text-emerald-300 hover:text-emerald-200"
        >
          ← Back to host console
        </Link>
      </div>
    </div>
  );
}

function BigStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-5 py-4">
      <p className="text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-sm text-slate-300">{label}</p>
      <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function sumRecent(sessions: ProxySession[], days: number) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return sessions
    .filter((s) => new Date(s.started_at).getTime() >= cutoff)
    .reduce((sum, s) => sum + (s.amount_sol ?? 0), 0);
}

function countRecent(sessions: ProxySession[], days: number) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return sessions.filter((s) => new Date(s.started_at).getTime() >= cutoff).length;
}

function buildDailySeries(sessions: ProxySession[], days: number) {
  const buckets: Array<{ label: string; key: string; earned: number }> = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.push({
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      key: d.toISOString().slice(0, 10),
      earned: 0,
    });
  }
  for (const s of sessions) {
    const key = s.started_at.slice(0, 10);
    const bucket = buckets.find((b) => b.key === key);
    if (bucket) bucket.earned += s.amount_sol ?? 0;
  }
  return buckets;
}
