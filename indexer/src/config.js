// Config — everything comes from the environment (see .env.example). No secrets
// are baked in; the defaults point at the public RPC + the live contracts.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Tiny .env loader (no dependency). Only sets keys that aren't already in env.
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "..", ".env");
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const num = (k, d) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : Number(v);
};

export const CFG = {
  rpcUrl: process.env.RPC_URL || "https://robinhoodchain.blockscout.com/api/eth-rpc",
  factory: (process.env.FACTORY || "0x44855d49E73Ad103Df51871A072FEe8709E6A2d6").toLowerCase(),
  router: (process.env.ROUTER || "0xAEFE708e04D3E2e9609e6bC987903b31818C2a46").toLowerCase(),
  startBlock: num("START_BLOCK", 0),
  port: num("PORT", 8787),
  pollMs: num("POLL_MS", 6000),
  chunk: num("CHUNK", 1500),
  confirmations: num("CONFIRMATIONS", 3),
  dbPath: process.env.DB_PATH || resolve(__dir, "..", "data", "robinlabs.db"),
  corsOrigin: process.env.CORS_ORIGIN || "*",

  // ── rewards (RewardVault merkle poster) ──
  rewardVault: (process.env.REWARD_VAULT || "").toLowerCase(), // "" disables Accrued indexing + posting
  epochLen: num("EPOCH_LEN", 7 * 24 * 3600),                   // MUST match RewardVault.EPOCH (7d default)
  finalityDelay: num("FINALITY_DELAY", 0),                     // MUST match RewardVault.finalityDelay (reorg gate)
  challengeWindow: num("CHALLENGE_WINDOW", 2 * 24 * 3600),     // = RewardVault.challengeWindow (claims open after this; shown in the UI)
  posterKey: process.env.POSTER_KEY || "",                     // poster private key; "" = compute+persist but don't post on-chain
  rewardUriBase: process.env.REWARD_URI_BASE || "",            // optional: prefix for the pinned leaf-set URI (else self /api URL)
};
