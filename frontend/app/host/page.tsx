"use client";

/**
 * /host — Host onboarding landing page.
 *
 * Two states:
 *   - Wallet not connected → hero + Connect Phantom CTA.
 *   - Wallet connected     → quick stats + the host's own hotspot listings.
 *
 * Form moved to /host/new; manage flow lives at /host/[id].
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getDashboard, getHostListings } from "@/lib/api";
import type { DashboardData, HotspotListing, ProxySession } from "@/lib/types";
import { useWallet, shortenAddress } from "@/lib/wallet";
import WalletButton from "@/components/WalletButton";
import SignalBars from "@/components/SignalBars";

export default function HostPage() {
  const { publicKey } = useWallet();
  const [listings, setListings] = useState<HotspotListing[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setError(err instanceof Error ? err.message : "Failed to load host data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  if (!publicKey) {
    return <ConnectPrompt />;
  }

  return (
    <ConnectedView
      publicKey={publicKey}
      listings={listings}
      dashboard={dashboard}
      loading={loading}
      error={error}
    />
  );
}

function ConnectPrompt() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="overflow-hidden rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(168,159,242,0.22),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(34,197,94,0.18),_transparent_35%),linear-gradient(180deg,#0b1220,#090d15)] px-8 py-12 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
        <p className="text-xs uppercase tracking-[0.3em] text-emerald-200/70">Become a host</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Earn SOL for every minute someone uses your hotspot.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
          Connect a Phantom wallet to list your first hotspot. You set the price, Netra
          handles paywall, payment proof, and Filecoin-backed receipts.
        </p>

        <div className="mt-8">
          <WalletButton />
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {[
            {
              title: "Price your bandwidth",
              body: "Set per-minute SOL pricing and a tier label so buyers know what to expect.",
            },
            {
              title: "Get paid on Solana",
              body: "Buyers pay directly to your wallet on devnet — every receipt is a real on-chain tx.",
            },
            {
              title: "Portable reputation",
              body: "Each session mints a Filecoin-style CID that follows your hotspot anywhere.",
            },
          ].map((card) => (
            <div
              key={card.title}
              className="rounded-2xl border border-white/8 bg-white/[0.04] p-5"
            >
              <p className="text-sm font-semibold text-white">{card.title}</p>
              <p className="mt-2 text-sm leading-6 text-slate-400">{card.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ConnectedViewProps {
  publicKey: string;
  listings: HotspotListing[];
  dashboard: DashboardData | null;
  loading: boolean;
  error: string | null;
}

function ConnectedView({ publicKey, listings, dashboard, loading, error }: ConnectedViewProps) {
  const stats = useMemo(() => buildStats(publicKey, listings, dashboard), [publicKey, listings, dashboard]);

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      <header className="overflow-hidden rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.18),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(168,159,242,0.18),_transparent_35%),linear-gradient(180deg,#0b1220,#090d15)] px-6 py-8 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-emerald-200/70">Host console</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Welcome back, {shortenAddress(publicKey)}.
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Manage every hotspot you own from one place. Add a new one, tune pricing,
              or pause a hotspot when you need to take it offline.
            </p>
          </div>
          <WalletButton variant="compact" />
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-2xl border border-white/8 bg-white/[0.04] px-5 py-4"
            >
              <p className="text-2xl font-semibold text-white">{stat.value}</p>
              <p className="mt-1 text-sm text-slate-500">{stat.label}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/host/new"
            className="rounded-full bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
          >
            + Add hotspot
          </Link>
          <Link
            href="/host/earnings"
            className="rounded-full border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            View earnings
          </Link>
          <Link
            href="/dashboard"
            className="rounded-full border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            Operations dashboard
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">Your hotspots</h2>
            <p className="text-sm text-slate-500">
              {listings.length === 0
                ? "Nothing live yet — list your first hotspot to start earning."
                : `${listings.length} listing${listings.length === 1 ? "" : "s"} tied to this wallet.`}
            </p>
          </div>
        </div>

        {loading && listings.length === 0 ? (
          <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-8 text-sm text-slate-400">
            Loading your hotspots…
          </div>
        ) : listings.length === 0 ? (
          <EmptyHostspots />
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {listings.map((listing) => (
              <HostHotspotCard
                key={listing.id}
                listing={listing}
                sessions={dashboard?.sessions ?? []}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyHostspots() {
  return (
    <div className="rounded-[28px] border border-dashed border-white/10 bg-[#0d1420] p-10 text-center">
      <h3 className="text-lg font-semibold text-white">List your first hotspot</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
        Anyone with a Mac sharing internet over Wi-Fi can list a hotspot. The whole
        flow takes about a minute and your wallet receives every payment directly.
      </p>
      <Link
        href="/host/new"
        className="mt-6 inline-flex rounded-full bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
      >
        + Add hotspot
      </Link>
    </div>
  );
}

interface HostCardProps {
  listing: HotspotListing;
  sessions: ProxySession[];
}

function HostHotspotCard({ listing, sessions }: HostCardProps) {
  const listingSessions = sessions.filter((s) => s.listing_id === listing.id);
  const active = listingSessions.filter((s) => s.active).length;
  const earned = listingSessions.reduce((sum, s) => sum + (s.amount_sol ?? 0), 0);
  const available = listing.status === "available";

  return (
    <Link
      href={`/host/${encodeURIComponent(listing.id)}`}
      className="group flex flex-col gap-4 rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(15,23,42,0.95),rgba(10,15,23,0.98))] p-5 transition-colors hover:border-emerald-400/30"
    >
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            available
              ? "bg-emerald-500/10 text-emerald-300"
              : "bg-amber-500/10 text-amber-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              available ? "animate-pulse bg-emerald-400" : "bg-amber-400"
            }`}
          />
          {available ? "Available" : "Paused"}
        </span>
        <SignalBars strength={listing.signalStrength} />
      </div>

      <div>
        <h3 className="text-base font-semibold text-white transition-colors group-hover:text-emerald-200">
          {listing.name}
        </h3>
        <p className="mt-0.5 text-sm text-slate-500">{listing.location || "No location set"}</p>
        {listing.ssid && (
          <p className="mt-2 inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-xs text-emerald-300">
            {listing.ssid}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs">
        <Stat label="Active" value={String(active)} />
        <Stat label="Earned" value={`${earned.toFixed(4)} SOL`} />
        <Stat label="Rate" value={`${listing.pricePerMinute}/min`} />
      </div>

      <div className="flex items-center justify-between border-t border-white/5 pt-3 text-xs text-slate-500">
        <span>{listing.downloadMbps}↓ / {listing.uploadMbps}↑ Mbps</span>
        <span className="text-emerald-300 transition group-hover:translate-x-0.5">Manage →</span>
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-white">{value}</div>
    </div>
  );
}

function buildStats(
  publicKey: string,
  listings: HotspotListing[],
  dashboard: DashboardData | null
) {
  const ids = new Set(listings.map((l) => l.id));
  const mySessions = (dashboard?.sessions ?? []).filter((s) => ids.has(s.listing_id));
  const earned = mySessions.reduce((sum, s) => sum + (s.amount_sol ?? 0), 0);
  const active = mySessions.filter((s) => s.active).length;

  return [
    { label: "Hotspots", value: String(listings.length) },
    { label: "Active sessions", value: String(active) },
    { label: "Earned (lifetime)", value: `${earned.toFixed(4)} SOL` },
    { label: "Wallet", value: shortenAddress(publicKey, 4, 4) },
  ];
}
