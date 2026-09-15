"use client";

import { shortenAddress, useWallet } from "@/lib/wallet";

interface Props {
  variant?: "primary" | "compact";
  className?: string;
}

export default function WalletButton({ variant = "primary", className = "" }: Props) {
  const { publicKey, connecting, installed, error, connect, disconnect } = useWallet();

  if (!installed) {
    return (
      <a
        href="https://phantom.app/download"
        target="_blank"
        rel="noreferrer"
        className={`inline-flex items-center gap-2 rounded-xl bg-[#ab9ff2] px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-[#bdb1fa] ${className}`}
      >
        <PhantomGlyph />
        Install Phantom
      </a>
    );
  }

  if (publicKey) {
    return (
      <div className={`inline-flex items-center gap-2 ${className}`}>
        <span className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          <span className="font-mono text-xs text-emerald-50">{shortenAddress(publicKey)}</span>
        </span>
        <button
          onClick={disconnect}
          className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          Disconnect
        </button>
      </div>
    );
  }

  const compact = variant === "compact";
  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      <button
        onClick={connect}
        disabled={connecting}
        className={`inline-flex items-center gap-2 rounded-xl bg-[#ab9ff2] font-semibold text-slate-950 transition hover:bg-[#bdb1fa] disabled:opacity-60 ${
          compact ? "px-3 py-2 text-sm" : "px-5 py-3 text-base"
        }`}
      >
        <PhantomGlyph />
        {connecting ? "Connecting…" : "Connect Phantom"}
      </button>
      {error && <span className="text-xs text-red-300">{error}</span>}
    </div>
  );
}

function PhantomGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
      <path d="M21.6 12.5c0 5.3-4.3 9.6-9.6 9.6S2.4 17.8 2.4 12.5 6.7 2.9 12 2.9s9.6 4.3 9.6 9.6Zm-13 .8c.7 0 1.3-.7 1.3-1.5s-.6-1.5-1.3-1.5-1.3.7-1.3 1.5.6 1.5 1.3 1.5Zm5.7 0c.7 0 1.3-.7 1.3-1.5s-.6-1.5-1.3-1.5-1.3.7-1.3 1.5.6 1.5 1.3 1.5Z" />
    </svg>
  );
}
