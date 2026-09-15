"use client";

import bs58 from "bs58";

const STORAGE_KEY = "netra.host.siws";

export interface HostAuthToken {
  pubkey: string;
  hotspotId: string;
  message: string;
  signature: string;
  issuedAt: string;
}

function buildMessage(pubkey: string, hotspotId: string, issuedAt: string) {
  return [
    "Netra Host Sign-In",
    "",
    `Wallet: ${pubkey}`,
    `Hotspot: ${hotspotId}`,
    `Issued At: ${issuedAt}`,
    "I am the host of this hotspot.",
  ].join("\n");
}

export async function signHostAuth(
  pubkey: string,
  hotspotId: string,
  signMessage: (data: Uint8Array) => Promise<Uint8Array>
): Promise<HostAuthToken> {
  const issuedAt = new Date().toISOString();
  const message = buildMessage(pubkey, hotspotId, issuedAt);
  const signed = await signMessage(new TextEncoder().encode(message));
  const token: HostAuthToken = {
    pubkey,
    hotspotId,
    message,
    signature: bs58.encode(signed),
    issuedAt,
  };
  if (typeof window !== "undefined") {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(token));
  }
  return token;
}

export function loadHostAuth(): HostAuthToken | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostAuthToken;
  } catch {
    return null;
  }
}

export function clearHostAuth() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(STORAGE_KEY);
}

export function authHeader(token: HostAuthToken | null): Record<string, string> {
  if (!token) return {};
  const payload = {
    pubkey: token.pubkey,
    hotspotId: token.hotspotId,
    message: token.message,
    signature: token.signature,
    issuedAt: token.issuedAt,
  };
  const encoded = btoa(JSON.stringify(payload));
  return { Authorization: `SIWS ${encoded}` };
}
