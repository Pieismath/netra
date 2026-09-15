import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ConnectionManager } from "../src";

function loadWallet(): Keypair {
  const raw = process.env.NETRA_WALLET_KEY;
  if (!raw) {
    throw new Error(
      "Set NETRA_WALLET_KEY to a base58 secret key string OR a JSON array of 64 bytes (matches `solana-keygen` output)."
    );
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function parseRegistry(): string[] {
  const raw = process.env.NETRA_HOTSPOTS ?? "http://localhost:3001";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const wallet = loadWallet();
  const maxBudgetSol = parseFloat(process.env.NETRA_MAX_BUDGET_SOL ?? "0.05");
  const sessionMinutes = parseInt(process.env.NETRA_SESSION_MINUTES ?? "5", 10);
  const registryUrls = parseRegistry();

  console.log(
    `[drone] booting agent — wallet ${wallet.publicKey.toBase58()}, budget ${maxBudgetSol} SOL, ${sessionMinutes}-min sessions`
  );
  console.log(`[drone] registry: ${registryUrls.join(", ")}`);

  const cm = new ConnectionManager({
    wallet,
    maxBudgetSol,
    sessionMinutes,
    registryUrls,
    rpcUrl: process.env.SOLANA_RPC,
    enableMdns: process.env.NETRA_DISABLE_MDNS !== "1",
    pollIntervalMs: 5000,
  });

  cm.on("connected", (s) => {
    console.log(
      `[drone] uplink up — session ${s.sessionId} via ${s.controlApiUrl}, paid until ${s.paidUntil}`
    );
  });
  cm.on("disconnected", (reason, err) => {
    console.log(
      `[drone] uplink lost (${reason})${err ? `: ${err.message}` : ""}`
    );
  });
  cm.on("budget-exhausted", (spent, limit) => {
    console.log(
      `[drone] budget reached (${spent}/${limit} lamports), shutting down`
    );
    void cm.stop().finally(() => process.exit(0));
  });
  cm.on("no-hotspots-found", () => {
    console.log("[drone] no hotspots in range, will retry on next poll");
  });
  cm.on("error", (err) => {
    console.error("[drone] error:", err.message);
  });

  await cm.start();

  const heartbeat = setInterval(() => {
    console.log("[ai] model heartbeat OK");
  }, 5000);

  const shutdown = async () => {
    console.log("\n[drone] shutting down");
    clearInterval(heartbeat);
    try {
      await cm.stop();
    } catch (err) {
      console.error("[drone] shutdown error:", (err as Error).message);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[drone] fatal:", err);
  process.exit(1);
});
