"use client";

import { useState } from "react";
import type { HotspotListing } from "@/lib/types";
import SignalBars from "./SignalBars";
import ConnectModal from "./ConnectModal";

export default function HotspotCard({ listing }: { listing: HotspotListing }) {
  const [showModal, setShowModal] = useState(false);
  const available = listing.status === "available";

  return (
    <>
      <div className="group relative flex flex-col gap-4 rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(15,23,42,0.95),rgba(10,15,23,0.98))] p-5 transition-colors hover:border-emerald-400/30">
        {/* Status badge */}
        <div className="flex items-center justify-between">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              available
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-amber-500/10 text-amber-400"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                available ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
              }`}
            />
            {available ? "Available" : "Occupied"}
          </span>
          <SignalBars strength={listing.signalStrength} />
        </div>

        {/* Name & location */}
        <div>
          <h3 className="text-base font-semibold text-white transition-colors group-hover:text-emerald-200">
            {listing.name}
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">{listing.location}</p>
          {listing.ssid && (
            <p className="mt-2 inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-xs text-emerald-300">
              WiFi: {listing.ssid}
            </p>
          )}
        </div>

        {/* Speed stats */}
        <div className="flex gap-4 text-xs text-slate-400">
          <div>
            <span className="text-slate-300 font-medium">{listing.downloadMbps}</span> Mbps ↓
          </div>
          <div>
            <span className="text-slate-300 font-medium">{listing.uploadMbps}</span> Mbps ↑
          </div>
        </div>

        {/* Price + connect */}
        <div className="flex items-center justify-between pt-1 border-t border-white/5">
          <div>
            <span className="text-lg font-bold text-white">
              {listing.pricePerMinute}
            </span>
            <span className="text-slate-400 text-sm"> SOL / min</span>
          </div>
          <button
            disabled={!available}
            onClick={() => setShowModal(true)}
            className={`min-h-[44px] rounded-xl px-4 py-2 text-sm font-semibold transition-all ${
              available
                ? "bg-emerald-400 text-slate-950 hover:bg-emerald-300"
                : "cursor-not-allowed bg-white/5 text-slate-500"
            }`}
          >
            {available ? "View Access" : "In use"}
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Host: {listing.host}</span>
          <span>
            Reliability {listing.reputation?.reliabilityScore ?? 100}%
          </span>
        </div>
      </div>

      {showModal && (
        <ConnectModal listing={listing} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
