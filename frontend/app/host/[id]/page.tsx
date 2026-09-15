"use client";

/**
 * /host/[id] — Manage a single hotspot.
 *
 * Edit price/location/description, toggle availability, delete, plus a
 * 14-day earnings line chart and session history table for this listing.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  deleteListing,
  getDashboard,
  getListings,
  upsertListing,
} from "@/lib/api";
import type { DashboardData, HotspotListing, ProxySession } from "@/lib/types";
import WalletButton from "@/components/WalletButton";
import SignalBars from "@/components/SignalBars";
import { useWallet } from "@/lib/wallet";

interface PageProps {
  params: Promise<{ id: string }>;
}

const TIER_OPTIONS: Array<{ value: "basic" | "standard" | "premium"; label: string }> = [
  { value: "basic", label: "Basic" },
  { value: "standard", label: "Standard" },
  { value: "premium", label: "Premium" },
];

const TIER_PRESETS: Record<"basic" | "standard" | "premium", { download: number; upload: number }> = {
  basic: { download: 50, upload: 25 },
  standard: { download: 150, upload: 50 },
  premium: { download: 300, upload: 100 },
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ManageHotspotPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const { publicKey } = useWallet();

  const [listing, setListing] = useState<HotspotListing | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pricePerMinute, setPricePerMinute] = useState("0");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [tier, setTier] = useState<"basic" | "standard" | "premium">("standard");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getListings(), getDashboard().catch(() => null)])
      .then(([listings, dash]) => {
        if (cancelled) return;
        const found = listings.find((l) => l.id === id) ?? null;
        if (!found) {
          setNotFound(true);
          return;
        }
        setListing(found);
        setDashboard(dash);
        setPricePerMinute(String(found.pricePerMinute));
        setLocation(found.location ?? "");
        setDescription(found.description ?? "");
        setTier(found.bandwidthTier ?? inferTierFromMbps(found.downloadMbps));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load hotspot");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const sessions = useMemo<ProxySession[]>(
    () => (dashboard?.sessions ?? []).filter((s) => s.listing_id === id),
    [dashboard, id]
  );

  const stats = useMemo(() => buildSessionStats(sessions), [sessions]);
  const dailyEarnings = useMemo(() => buildDailySeries(sessions, 14), [sessions]);

  if (loading) {
    return <PageShell><LoadingState /></PageShell>;
  }
  if (notFound) {
    return <PageShell><NotFoundState id={id} /></PageShell>;
  }
  if (!listing) {
    return <PageShell><LoadingState /></PageShell>;
  }

  const isOwner = publicKey && listing.hostWallet && publicKey === listing.hostWallet;
  const available = listing.status === "available";

  async function persist(partial: Partial<HotspotListing> & { status?: HotspotListing["status"] }) {
    if (!listing) return;
    const wallet = listing.hostWallet ?? publicKey;
    if (!wallet) {
      setError("Connect a wallet to update this listing.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const merged: HotspotListing = { ...listing, ...partial };
      const updated = await upsertListing({
        id: merged.id,
        name: merged.name,
        ssid: merged.ssid ?? "",
        location: merged.location,
        pricePerMinute: merged.pricePerMinute,
        downloadMbps: merged.downloadMbps,
        uploadMbps: merged.uploadMbps,
        signalStrength: merged.signalStrength,
        host: merged.host,
        hostWallet: wallet,
        hostIp: merged.hostIp,
        description: merged.description,
        bandwidthTier: merged.bandwidthTier,
        status: merged.status ?? "available",
        real: merged.real ?? true,
      });
      setListing(updated);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const price = Number(pricePerMinute);
    if (!Number.isFinite(price) || price < 0.0001) {
      setError("Price must be at least 0.0001 SOL/min.");
      return;
    }
    const preset = TIER_PRESETS[tier];
    await persist({
      pricePerMinute: price,
      location: location.trim() || "Location unset",
      description: description.trim() || undefined,
      bandwidthTier: tier,
      downloadMbps: preset.download,
      uploadMbps: preset.upload,
    });
  }

  async function handleToggle() {
    await persist({ status: available ? "occupied" : "available" });
  }

  async function handleDelete() {
    if (!listing) return;
    setDeleting(true);
    try {
      await deleteListing(listing.id);
      router.push("/host");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <PageShell>
      <div className="mb-6 flex items-center justify-between gap-3">
        <Link href="/host" className="text-sm text-slate-400 hover:text-white">
          ← Host console
        </Link>
        <WalletButton variant="compact" />
      </div>

      <header className="overflow-hidden rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.18),_transparent_30%),linear-gradient(180deg,#0b1220,#090d15)] px-6 py-7 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-emerald-300/70">Manage hotspot</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">{listing.name}</h1>
            <p className="mt-1 text-sm text-slate-400">
              {listing.ssid && <span className="font-mono text-emerald-300">{listing.ssid}</span>}
              {listing.ssid && " · "}
              <span>{listing.location || "No location set"}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SignalBars strength={listing.signalStrength} />
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                available
                  ? "bg-emerald-500/10 text-emerald-300"
                  : "bg-amber-500/10 text-amber-300"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${available ? "animate-pulse bg-emerald-400" : "bg-amber-400"}`} />
              {available ? "Available" : "Paused"}
            </span>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          <Stat label="Lifetime earned" value={`${stats.totalEarned.toFixed(4)} SOL`} />
          <Stat label="Sessions served" value={String(stats.totalSessions)} />
          <Stat label="Active now" value={String(stats.active)} />
          <Stat label="Rate" value={`${listing.pricePerMinute} SOL/min`} />
        </div>
      </header>

      {!isOwner && (
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          You&apos;re viewing this as a non-owner. Connect the wallet{" "}
          <span className="font-mono text-xs text-amber-100">{listing.hostWallet}</span>{" "}
          to make changes.
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="space-y-6">
          <form
            onSubmit={handleSave}
            className="space-y-5 rounded-[28px] border border-white/8 bg-[#0d1420] p-6"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Listing details</h2>
              {savedAt && Date.now() - savedAt < 4000 && (
                <span className="text-xs text-emerald-300">Saved ✓</span>
              )}
            </div>

            <Field label="Price per minute (SOL)">
              <input
                type="number"
                step="0.0001"
                min="0.0001"
                value={pricePerMinute}
                onChange={(e) => setPricePerMinute(e.target.value)}
                disabled={!isOwner}
                className={inputCls}
              />
            </Field>

            <Field label="Bandwidth tier">
              <div className="grid grid-cols-3 gap-2">
                {TIER_OPTIONS.map((opt) => {
                  const active = tier === opt.value;
                  const preset = TIER_PRESETS[opt.value];
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTier(opt.value)}
                      disabled={!isOwner}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        active
                          ? "border-emerald-400/60 bg-emerald-500/10 text-white"
                          : "border-white/8 bg-white/[0.03] text-slate-300 hover:border-white/20"
                      } disabled:opacity-50`}
                    >
                      <div className="text-sm font-semibold">{opt.label}</div>
                      <div className="mt-0.5 text-xs text-slate-400">
                        {preset.download}↓ / {preset.upload}↑ Mbps
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Location">
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                disabled={!isOwner}
                className={inputCls}
              />
            </Field>

            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                disabled={!isOwner}
                className={`${inputCls} resize-y`}
              />
            </Field>

            <button
              type="submit"
              disabled={!isOwner || saving}
              className="w-full rounded-xl bg-emerald-400 py-3 font-semibold text-slate-950 transition-colors hover:bg-emerald-300 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </form>

          <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Availability</h2>
                <p className="mt-1 text-sm text-slate-400">
                  {available
                    ? "Hotspot is live and accepting paid sessions."
                    : "Hotspot is paused. Buyers can&apos;t start new sessions."}
                </p>
              </div>
              <button
                onClick={handleToggle}
                disabled={!isOwner || saving}
                className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
                  available
                    ? "border border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
                    : "bg-emerald-400 text-slate-950 hover:bg-emerald-300"
                }`}
              >
                {available ? "Pause hotspot" : "Resume hotspot"}
              </button>
            </div>
          </div>

          <div className="rounded-[28px] border border-red-500/20 bg-red-500/[0.05] p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Delete hotspot</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Removes the listing from the marketplace permanently. Past sessions
                  and Filecoin receipts are not affected.
                </p>
              </div>
              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={!isOwner}
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                >
                  Delete…
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/10"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="rounded-xl bg-red-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-400 disabled:opacity-50"
                  >
                    {deleting ? "Deleting…" : "Confirm delete"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-6">
          <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-6">
            <h2 className="text-lg font-semibold text-white">Earnings · last 14 days</h2>
            <p className="mt-1 text-sm text-slate-500">
              Total {stats.last14.toFixed(4)} SOL across {dailyEarnings.length} day buckets
            </p>
            <div className="mt-4 h-48">
              {dailyEarnings.some((d) => d.earned > 0) ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dailyEarnings}>
                    <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                    <XAxis dataKey="label" stroke="#475569" fontSize={11} tickLine={false} />
                    <YAxis stroke="#475569" fontSize={11} tickLine={false} width={48} />
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
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  No earnings yet for this hotspot.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-6">
            <h2 className="text-lg font-semibold text-white">Session history</h2>
            <p className="mt-1 text-sm text-slate-500">
              Latest paid sessions for this hotspot
            </p>
            <div className="mt-4 overflow-hidden rounded-2xl border border-white/8">
              <table className="min-w-full divide-y divide-white/8 text-sm">
                <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Started</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Earned</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/8 bg-[#091019] text-slate-200">
                  {sessions.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">
                        No sessions recorded yet.
                      </td>
                    </tr>
                  ) : (
                    sessions
                      .slice()
                      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
                      .slice(0, 8)
                      .map((s) => (
                        <tr key={s.session_id}>
                          <td className="px-4 py-3 text-xs text-slate-300">{fmtDate(s.started_at)}</td>
                          <td className="px-4 py-3 text-xs">{s.session_type === "agent" ? "x402" : "Portal"}</td>
                          <td className="px-4 py-3 text-xs text-emerald-300">
                            {(s.amount_sol ?? 0).toFixed(4)} SOL
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-400">
                            {s.status.replace("_", " ")}
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">{children}</div>;
}

function LoadingState() {
  return (
    <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-8 text-sm text-slate-400">
      Loading hotspot…
    </div>
  );
}

function NotFoundState({ id }: { id: string }) {
  return (
    <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-8 text-center">
      <h1 className="text-2xl font-semibold text-white">Hotspot not found</h1>
      <p className="mt-2 text-sm text-slate-400">
        No listing with id <span className="font-mono text-xs text-slate-300">{id}</span> exists,
        or it has been deleted.
      </p>
      <Link
        href="/host"
        className="mt-6 inline-flex rounded-full bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-300"
      >
        ← Back to host console
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-5 py-4">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="mt-1 text-sm text-slate-500">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-slate-300">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full bg-[#0f0f1a] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-emerald-400/60 transition-colors disabled:opacity-50";

function inferTierFromMbps(downloadMbps: number): "basic" | "standard" | "premium" {
  if (downloadMbps >= 250) return "premium";
  if (downloadMbps >= 100) return "standard";
  return "basic";
}

function buildSessionStats(sessions: ProxySession[]) {
  const totalEarned = sessions.reduce((sum, s) => sum + (s.amount_sol ?? 0), 0);
  const active = sessions.filter((s) => s.active).length;
  const cutoff14 = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const last14 = sessions
    .filter((s) => new Date(s.started_at).getTime() >= cutoff14)
    .reduce((sum, s) => sum + (s.amount_sol ?? 0), 0);
  return { totalEarned, totalSessions: sessions.length, active, last14 };
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
