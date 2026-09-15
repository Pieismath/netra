import type { HttpClient } from "./http";
import { joinUrl } from "./http";
import type { HotspotListing, Network } from "./types";

export const NETRA_MDNS_SERVICE_TYPE = "netra";

export interface DiscoverOptions {
  registryUrls?: string[];
  mdnsTimeoutMs?: number;
  enableMdns?: boolean;
  http: HttpClient;
}

interface RawListing {
  id?: string;
  name?: string;
  ssid?: string;
  pricePerMinute?: number;
  hostWallet?: string;
  host?: string;
  network?: string;
  reputation?: number;
  status?: string;
}

function asNetwork(value: string | undefined): Network {
  if (value === "solana-mainnet" || value === "solana-testnet") return value;
  return "solana-devnet";
}

async function probeRegistry(
  url: string,
  http: HttpClient
): Promise<HotspotListing[]> {
  try {
    const res = await http.get<RawListing[] | { listings: RawListing[] }>(
      joinUrl(url, "/listings")
    );
    if (res.status < 200 || res.status >= 300) return [];
    const listings: RawListing[] = Array.isArray(res.data)
      ? res.data
      : Array.isArray((res.data as { listings?: RawListing[] }).listings)
      ? (res.data as { listings: RawListing[] }).listings
      : [];
    return listings
      .filter((l) => typeof l.id === "string" && typeof l.pricePerMinute === "number")
      .map<HotspotListing>((l) => ({
        id: l.id as string,
        controlApiUrl: url,
        name: l.name ?? l.id ?? "unnamed",
        ssid: l.ssid,
        pricePerMinute: l.pricePerMinute as number,
        hostWallet: l.hostWallet ?? l.host,
        network: asNetwork(l.network),
        reputation: l.reputation,
        source: "registry",
        raw: l,
      }));
  } catch {
    return [];
  }
}

interface MdnsCandidate {
  id: string;
  controlApiUrl: string;
  name: string;
  pricePerMinute: number;
  hostWallet?: string;
  network: Network;
}

interface MdnsService {
  host?: string;
  addresses?: string[];
  port?: number;
  txt?: Record<string, string>;
  name?: string;
}

interface BonjourInstance {
  find(opts: { type: string }, cb: (svc: MdnsService) => void): unknown;
  destroy(): void;
}

type BonjourConstructor = new () => BonjourInstance;

async function discoverMdns(timeoutMs: number): Promise<MdnsCandidate[]> {
  let BonjourCtor: BonjourConstructor | null = null;
  try {
    const mod: { Bonjour?: unknown; default?: unknown } = await import("bonjour-service");
    const ctor = mod.Bonjour ?? mod.default;
    if (typeof ctor === "function") BonjourCtor = ctor as BonjourConstructor;
  } catch {
    return [];
  }
  if (!BonjourCtor) return [];
  const Ctor = BonjourCtor;

  return new Promise<MdnsCandidate[]>((resolve) => {
    const candidates: MdnsCandidate[] = [];
    let bonjour: BonjourInstance | null = null;
    try {
      bonjour = new Ctor();
      bonjour.find({ type: NETRA_MDNS_SERVICE_TYPE }, (svc) => {
        const txt = svc.txt ?? {};
        const id = txt.id ?? svc.name;
        const priceRaw = txt.price ?? txt.pricePerMinute;
        const price = priceRaw !== undefined ? Number(priceRaw) : undefined;
        if (!id || price === undefined || !Number.isFinite(price)) return;
        const host = (svc.addresses && svc.addresses[0]) ?? svc.host;
        const port = svc.port;
        if (!host || !port) return;
        const apiOverride = txt.api;
        const controlApiUrl = apiOverride ?? `http://${host}:${port}`;
        candidates.push({
          id,
          controlApiUrl,
          name: txt.name ?? svc.name ?? id,
          pricePerMinute: price,
          hostWallet: txt.wallet ?? txt.hostWallet,
          network: asNetwork(txt.network),
        });
      });
    } catch {
      resolve([]);
      return;
    }

    setTimeout(() => {
      try {
        bonjour?.destroy();
      } catch {
        /* noop */
      }
      resolve(candidates);
    }, timeoutMs);
  });
}

export async function discover(opts: DiscoverOptions): Promise<HotspotListing[]> {
  const registryUrls = opts.registryUrls ?? [];
  const mdnsEnabled = opts.enableMdns !== false;
  const mdnsTimeoutMs = opts.mdnsTimeoutMs ?? 2000;

  const tasks: Promise<HotspotListing[]>[] = registryUrls.map((url) =>
    probeRegistry(url, opts.http)
  );
  if (mdnsEnabled) {
    tasks.push(
      discoverMdns(mdnsTimeoutMs).then((candidates) =>
        candidates.map<HotspotListing>((c) => ({
          id: c.id,
          controlApiUrl: c.controlApiUrl,
          name: c.name,
          pricePerMinute: c.pricePerMinute,
          hostWallet: c.hostWallet,
          network: c.network,
          source: "mdns",
        }))
      )
    );
  }

  const settled = await Promise.all(tasks);
  const all = settled.flat();

  const byId = new Map<string, HotspotListing>();
  for (const listing of all) {
    const existing = byId.get(listing.id);
    if (!existing || listing.source === "mdns") {
      byId.set(listing.id, listing);
    }
  }
  return Array.from(byId.values());
}
