"use client";

/**
 * Minimal Phantom wallet adapter scaffolding.
 *
 * Coordinates with prompt 5: if a richer wallet adapter ships there, this hook
 * can be replaced — keep the shape (publicKey, connect, disconnect) stable.
 */

import { useCallback, useEffect, useState } from "react";

interface PhantomPublicKey {
  toString(): string;
  toBase58?: () => string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PhantomPublicKey | null;
  isConnected?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PhantomPublicKey }>;
  disconnect: () => Promise<void>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    solana?: PhantomProvider;
    phantom?: { solana?: PhantomProvider };
  }
}

export function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const provider = window.phantom?.solana ?? window.solana;
  return provider?.isPhantom ? provider : null;
}

export function shortenAddress(addr: string | null | undefined, head = 4, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export interface WalletState {
  publicKey: string | null;
  connecting: boolean;
  installed: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useWallet(): WalletState {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [installed, setInstalled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const provider = getPhantom();
    if (!provider) {
      setInstalled(false);
      return;
    }
    setInstalled(true);

    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => setPublicKey(res.publicKey.toString()))
      .catch(() => {
        // user has not yet trusted this site — silent fail is correct here
      });

    const onConnect = () => {
      const key = provider.publicKey?.toString() ?? null;
      setPublicKey(key);
    };
    const onDisconnect = () => setPublicKey(null);
    const onAccountChanged = (...args: unknown[]) => {
      const newPk = args[0] as PhantomPublicKey | null | undefined;
      setPublicKey(newPk ? newPk.toString() : null);
    };

    provider.on?.("connect", onConnect);
    provider.on?.("disconnect", onDisconnect);
    provider.on?.("accountChanged", onAccountChanged);
    return () => {
      provider.removeListener?.("connect", onConnect);
      provider.removeListener?.("disconnect", onDisconnect);
      provider.removeListener?.("accountChanged", onAccountChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = getPhantom();
    if (!provider) {
      setInstalled(false);
      setError("Phantom wallet not detected. Install it at phantom.app.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await provider.connect();
      setPublicKey(res.publicKey.toString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = getPhantom();
    if (!provider) return;
    try {
      await provider.disconnect();
    } finally {
      setPublicKey(null);
    }
  }, []);

  return { publicKey, connecting, installed, error, connect, disconnect };
}
