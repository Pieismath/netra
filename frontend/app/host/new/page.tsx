"use client";

/**
 * /host/new — Create a new hotspot listing.
 *
 * Tier choices map to download/upload Mbps presets, and the SSID/host fields
 * derive automatically from name + connected wallet so the form stays short.
 * On success we redirect to /host/[id] for management.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { upsertListing } from "@/lib/api";
import { useWallet, shortenAddress } from "@/lib/wallet";
import WalletButton from "@/components/WalletButton";
import { buildHotspotSsid, SSID_PREFIX } from "@/lib/ssid";

type Tier = "basic" | "standard" | "premium";

const TIER_PRESETS: Record<Tier, { label: string; download: number; upload: number; blurb: string }> = {
  basic: { label: "Basic", download: 50, upload: 25, blurb: "Casual browsing, light streaming" },
  standard: { label: "Standard", download: 150, upload: 50, blurb: "HD video, video calls, agents" },
  premium: { label: "Premium", download: 300, upload: 100, blurb: "4K, large downloads, busy events" },
};

const NAME_LIMIT = 32;

function deriveHostIp() {
  if (typeof window === "undefined") return undefined;
  const host = window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") return undefined;
  return host;
}

function freshId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `hotspot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function NewListingPage() {
  const router = useRouter();
  const { publicKey } = useWallet();

  const [name, setName] = useState("");
  const [pricePerMinute, setPricePerMinute] = useState("0.001");
  const [tier, setTier] = useState<Tier>("standard");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!publicKey) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <div className="rounded-[28px] border border-white/8 bg-[#0d1420] p-8 text-center">
          <h1 className="text-2xl font-semibold text-white">Connect a wallet first</h1>
          <p className="mt-2 text-sm text-slate-400">
            Listings are tied to the host wallet that receives payouts. Connect Phantom
            to continue.
          </p>
          <div className="mt-6 flex justify-center">
            <WalletButton />
          </div>
          <Link href="/host" className="mt-4 inline-block text-sm text-emerald-300 hover:text-emerald-200">
            ← Back to host console
          </Link>
        </div>
      </div>
    );
  }

  const preset = TIER_PRESETS[tier];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!publicKey) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Hotspot name is required.");
      return;
    }
    const price = Number(pricePerMinute);
    if (!Number.isFinite(price) || price < 0.0001) {
      setError("Price must be at least 0.0001 SOL/min.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const id = freshId();
      const listing = await upsertListing({
        id,
        name: trimmedName,
        ssid: buildHotspotSsid(trimmedName) || `${SSID_PREFIX}Hotspot`,
        location: location.trim() || "Location unset",
        pricePerMinute: price,
        downloadMbps: preset.download,
        uploadMbps: preset.upload,
        signalStrength: 4,
        host: shortenAddress(publicKey),
        hostWallet: publicKey,
        hostIp: deriveHostIp(),
        description: description.trim() || undefined,
        bandwidthTier: tier,
        status: "available",
        real: true,
      });
      router.push(`/host/${encodeURIComponent(listing.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create listing");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/host" className="text-sm text-slate-400 hover:text-white">
          ← Host console
        </Link>
        <WalletButton variant="compact" />
      </div>

      <div className="mb-8">
        <p className="text-xs uppercase tracking-[0.28em] text-emerald-300/70">Add hotspot</p>
        <h1 className="mt-3 text-3xl font-bold text-white">List a new hotspot</h1>
        <p className="mt-2 text-slate-400">
          Payouts go to <span className="font-mono text-white">{shortenAddress(publicKey)}</span>.
          Edit anything later from the manage screen.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Hotspot name" hint={`${name.length}/${NAME_LIMIT}`}>
          <input
            required
            maxLength={NAME_LIMIT}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CafeNova Uplink"
            className={inputCls}
          />
          {name.trim().length > 0 && (
            <p className="mt-1.5 font-mono text-xs text-slate-500">
              SSID will be <span className="text-emerald-300">{buildHotspotSsid(name) || `${SSID_PREFIX}—`}</span>
            </p>
          )}
        </Field>

        <Field label="Price per minute (SOL)" hint="Minimum 0.0001">
          <input
            required
            type="number"
            step="0.0001"
            min="0.0001"
            value={pricePerMinute}
            onChange={(e) => setPricePerMinute(e.target.value)}
            className={inputCls}
          />
        </Field>

        <Field label="Bandwidth tier" hint="Informational — sets buyer expectations">
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(TIER_PRESETS) as Tier[]).map((key) => {
              const opt = TIER_PRESETS[key];
              const active = tier === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTier(key)}
                  className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                    active
                      ? "border-emerald-400/60 bg-emerald-500/10 text-white"
                      : "border-white/8 bg-white/[0.03] text-slate-300 hover:border-white/20"
                  }`}
                >
                  <div className="text-sm font-semibold">{opt.label}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {opt.download}↓ / {opt.upload}↑ Mbps
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-slate-500">{opt.blurb}</div>
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Location" hint="Optional, helps buyers find you">
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Philadelphia, PA · University City"
            className={inputCls}
          />
        </Field>

        <Field label="Description" hint="What makes this hotspot special?">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Quiet corner cafe with wired uplink, 24/7 access during business hours."
            rows={4}
            className={`${inputCls} resize-y`}
          />
        </Field>

        {error && (
          <p className="rounded-lg bg-red-400/10 px-3 py-2 text-sm text-red-300">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-xl bg-emerald-400 py-3 font-semibold text-slate-950 transition-colors hover:bg-emerald-300 disabled:opacity-50"
        >
          {submitting ? "Listing…" : "List hotspot"}
        </button>
      </form>
    </div>
  );
}

const inputCls =
  "w-full bg-[#0f0f1a] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 text-sm focus:outline-none focus:border-emerald-400/60 transition-colors";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-slate-300">{label}</label>
        {hint && <span className="text-xs text-slate-500">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
