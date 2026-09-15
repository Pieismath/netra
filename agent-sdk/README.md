# netra-agent-sdk

Embed-and-forget connectivity for autonomous agents — drones, AVs, robots — that need persistent uplink across transit and remote zones. The SDK runs the full Netra x402 protocol against any reachable hotspot, signs and broadcasts Solana payments with the agent's own wallet, and keeps the link alive while the host application does whatever it does.

This is the hero use case for [Netra](../README.md): edge-AI devices that today lose connectivity the moment they wander past a managed access point.

## Why

Captive portals assume a human will tap "I agree" and enter a credit card. That doesn't work for a drone scoring a delivery route or an AV streaming sensor data home. Netra hotspots speak HTTP 402 — the SDK answers them programmatically:

1. Discover hotspots in range (mDNS or registry URL).
2. Request a session → receive an x402 payment challenge.
3. Sign the Solana transfer with the embedded wallet, broadcast.
4. Retry with the signature → receive a session and a paid uplink.
5. Auto-extend before expiry, recover prorated refunds on disconnect, hop to the next hotspot when signal drops.

Bring your own keypair, set a SOL budget, and the agent stays online.

## Install

```bash
npm install netra-agent-sdk
```

Requires Node.js 18+.

## Quickstart

```ts
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ConnectionManager } from "netra-agent-sdk";

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.NETRA_WALLET_KEY!));

const cm = new ConnectionManager({
  wallet,
  maxBudgetSol: 0.05,
  sessionMinutes: 5,
  registryUrls: ["http://hotspot.local:3001"],
});

cm.on("connected", (s) => console.log("uplink up:", s.sessionId));
cm.on("disconnected", (reason) => console.log("uplink lost:", reason));
cm.on("budget-exhausted", () => process.exit(0));

await cm.start();
```

That's the entire integration. The manager handles discovery, purchase, extension, and reconnection on its own.

## Environment variables

| Var | Purpose | Default |
| --- | --- | --- |
| `NETRA_WALLET_KEY` | Agent wallet. Either base58 secret key string OR JSON array of 64 bytes. | required |
| `NETRA_MAX_BUDGET_SOL` | Hard cap. Manager refuses purchases that would exceed this. | `0.05` |
| `NETRA_SESSION_MINUTES` | Length of each purchased session. | `5` |
| `NETRA_HOTSPOTS` | Comma-separated control API base URLs (registry fallback when mDNS fails). | `http://localhost:3001` |
| `SOLANA_RPC` | Solana RPC URL. | `https://api.devnet.solana.com` |
| `NETRA_DISABLE_MDNS` | Set to `1` to skip mDNS browse. | unset |

## API

### `NetraClient`

Stateless protocol client. Use directly when you want full control over each session.

```ts
const client = new NetraClient({
  wallet,
  controlApiUrl: "http://hotspot.local:3001",  // optional default
  rpcUrl: "https://api.devnet.solana.com",
});

const listings = await client.discover();
const result = await client.purchase(listings[0].id, 10);
console.log(result.session.sessionId, result.session.paidUntil);

await client.extend(result.session.sessionId, 5);
const refund = await client.disconnect(result.session.sessionId);
```

### `ConnectionManager`

Long-running policy loop on top of `NetraClient`. Handles reconnection, auto-extend, budget enforcement.

Events:

- `connected(session)` — emitted on every successful purchase or extend.
- `disconnected(reason, error?)` — `reason` is `"manual" | "expired" | "signal-loss" | "error" | "budget-exhausted"`.
- `budget-exhausted(spentLamports, limitLamports)` — manager has refused or will refuse the next purchase.
- `no-hotspots-found()` — discovery returned nothing; the manager keeps polling.
- `error(error)` — non-fatal error during the loop.

`getSignalStrength()` — optional callback returning a number in `[0, 1]`. The default returns `1.0`, so the manager only triggers a hop when the session expires or you call `stop()`. On real platforms, replace this with the platform-native API (PX4 telemetry, ROS2 `/wifi/signal`, vehicle CAN bus).

## Discovery

The SDK looks for hotspots two ways:

1. **mDNS browse** of `_netra._tcp.local`. Each hotspot's TXT record carries `id`, `pricePerMinute`, optional `wallet`, `network`, `name`, `api`. The `controlApiUrl` is built from the resolved address+port unless `api` overrides.
2. **Registry probe** — for every URL in `registryUrls`, the SDK does `GET /listings` and maps the response to `HotspotListing[]`.

Results are merged and deduped by `id`; mDNS wins ties.

> **Known limitation.** As of this version, the captive portal does **not** advertise itself via mDNS. Until that lands (a startup change to `captive-portal/server.js` registering the `_netra._tcp.local` service), use the `NETRA_HOTSPOTS` env var to point at known control planes. Once advertising is in place, the mDNS path lights up automatically — no SDK changes needed.

## Running the demo locally

```bash
# 1. Start the Netra control plane
cd ../proxy-server
npm install
npm start          # listens on :3001

# 2. Build and run the SDK demo
cd ../agent-sdk
npm install
npm run build      # tsc → dist/

# 3. Fund a devnet wallet (one-time)
solana-keygen new --outfile ./agent.json --no-bip39-passphrase
solana airdrop 0.1 $(solana-keygen pubkey ./agent.json) --url devnet

# 4. Run the drone
export NETRA_WALLET_KEY="$(cat ./agent.json)"
export NETRA_HOTSPOTS=http://localhost:3001
export NETRA_MAX_BUDGET_SOL=0.05
export NETRA_SESSION_MINUTES=5
npm run demo
```

Expected output:

```
[drone] booting agent — wallet ABC...XYZ, budget 0.05 SOL, 5-min sessions
[drone] registry: http://localhost:3001
[drone] uplink up — session <uuid> via http://localhost:3001, paid until 2026-...
[ai] model heartbeat OK
[ai] model heartbeat OK
...
```

After ~`sessionMinutes - 30s` the manager auto-extends. Hit Ctrl-C and the demo calls `disconnect()` to recover the prorated refund before exiting.

## Testing

```bash
npm test
```

Unit tests use `node:test` with a fake HTTP client and fake Solana payer — no validator needed. The full x402 retry protocol (challenge → sign → finalize, plus extend and disconnect) is verified against the exact response shapes that `proxy-server` returns.

## Integration story

The SDK is meant to drop into any long-running agent process where uplink is a dependency, not the product:

- **Drones / UAVs**: PX4 or ArduPilot companion computers running mission code. `getSignalStrength` reads from `iw dev wlan0 link` or the flight controller's link metric. The agent purchases ~5-min sessions as it flies through coverage zones, hands off as it leaves.
- **Autonomous vehicles**: edge inference pipelines that need persistent telemetry uplink. Per-minute pricing aligns with the cost model of disposable in-transit connectivity.
- **Field robotics / sensor fleets**: low-duty-cycle devices that wake, upload, settle. Tight `maxBudgetSol` keeps an unattended fleet from running away with the wallet.

Refunds for the unused tail of a session go back to the buyer wallet automatically when the agent disconnects cleanly. Budget tracking is best-effort: confirmed refunds reduce the running spend so the same wallet can keep purchasing.

## Caveats

- **IP detection.** The SDK auto-detects the first non-loopback IPv4 from `os.networkInterfaces()`. Override with the `ip` option if your device is behind NAT or you want to force a specific value.
- **Refund destination.** The proxy-server currently refunds to the original buyer wallet. The constructor accepts a `refundDestination` for forward compatibility, but until the server supports per-disconnect overrides it is advisory.
- **Server-side mDNS** is not yet implemented. See "Discovery" above.
