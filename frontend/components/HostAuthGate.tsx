"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  clearHostAuth,
  loadHostAuth,
  signHostAuth,
  type HostAuthToken,
} from "@/lib/auth";

interface Props {
  hotspotId: string;
  children: (token: HostAuthToken) => ReactNode;
}

export default function HostAuthGate({ hotspotId, children }: Props) {
  const { wallet, publicKey, connect, connecting, connected, disconnect, signMessage, select, wallets } =
    useWallet();
  const [token, setToken] = useState<HostAuthToken | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = loadHostAuth();
    if (existing) setToken(existing);
  }, []);

  useEffect(() => {
    if (wallet) return;
    const phantom = wallets.find((w) => w.adapter.name === "Phantom");
    if (phantom) select(phantom.adapter.name);
  }, [wallet, wallets, select]);

  useEffect(() => {
    if (!publicKey || !token) return;
    if (token.pubkey !== publicKey.toBase58() || token.hotspotId !== hotspotId) {
      clearHostAuth();
      setToken(null);
    }
  }, [publicKey, token, hotspotId]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connect failed");
    }
  }, [connect]);

  const handleSign = useCallback(async () => {
    if (!publicKey || !signMessage) {
      setError("Wallet does not support message signing");
      return;
    }
    setSigning(true);
    setError(null);
    try {
      const next = await signHostAuth(publicKey.toBase58(), hotspotId, signMessage);
      setToken(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setSigning(false);
    }
  }, [publicKey, signMessage, hotspotId]);

  const handleSignOut = useCallback(async () => {
    clearHostAuth();
    setToken(null);
    try {
      await disconnect();
    } catch {
      // ignore
    }
  }, [disconnect]);

  if (token && publicKey && token.pubkey === publicKey.toBase58()) {
    return (
      <>
        <div className="mx-auto max-w-7xl px-4 pt-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-100">
            <span className="font-mono break-all">
              Signed in as {token.pubkey.slice(0, 6)}…{token.pubkey.slice(-4)}
            </span>
            <button
              onClick={handleSignOut}
              className="min-h-[44px] rounded-full border border-white/10 px-3 py-1 text-emerald-100 transition hover:bg-white/10"
            >
              Sign out
            </button>
          </div>
        </div>
        {children(token)}
      </>
    );
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      <div className="w-full rounded-3xl border border-white/10 bg-[#0d1420] p-8 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
        <p className="text-xs uppercase tracking-[0.3em] text-emerald-200/70">Host Dashboard</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">Connect your host wallet</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          The dashboard is private. Connect Phantom and sign the host attestation to view sessions, payouts, and CID artifacts for hotspot{" "}
          <span className="font-mono text-slate-200">{hotspotId}</span>.
        </p>

        {!connected ? (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="mt-6 min-h-[44px] w-full rounded-2xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:opacity-50"
          >
            {connecting ? "Connecting…" : "Connect Phantom"}
          </button>
        ) : (
          <div className="mt-6 space-y-3">
            <p className="break-all rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-xs text-slate-300">
              {publicKey?.toBase58()}
            </p>
            <button
              onClick={handleSign}
              disabled={signing || !signMessage}
              className="min-h-[44px] w-full rounded-2xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:opacity-50"
            >
              {signing ? "Awaiting signature…" : "Sign host attestation"}
            </button>
            <button
              onClick={handleSignOut}
              className="min-h-[44px] w-full rounded-2xl border border-white/10 bg-transparent py-3 text-sm font-medium text-slate-400 transition hover:bg-white/5"
            >
              Disconnect
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
