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
  // Upstream fallback for the /rpc read-proxy if the primary (paid) RPC errors.
  rpcFallback: process.env.RPC_FALLBACK || "https://robinhoodchain.blockscout.com/api/eth-rpc",
  rpcProxy: (process.env.RPC_PROXY ?? "1") !== "0",   // expose POST /rpc (read-only JSON-RPC proxy)
  rpcProxyMaxPerSec: num("RPC_PROXY_MAX_PER_SEC", 40), // per-IP/sec cap on upstream calls (a batch counts by its method count)
  factory: (process.env.FACTORY || "0x7E9E3BC24013e6f607e89c52E619B6FD77334DC2").toLowerCase(),
  router: (process.env.ROUTER || "0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F").toLowerCase(),
  startBlock: num("START_BLOCK", 0),
  port: num("PORT", 8787),
  pollMs: num("POLL_MS", 6000),
  chunk: num("CHUNK", 1500),
  confirmations: num("CONFIRMATIONS", 3),
  dbPath: process.env.DB_PATH || resolve(__dir, "..", "data", "robinlabs.db"),
  corsOrigin: process.env.CORS_ORIGIN || "*",

  // ── coin profiles (creator-signed off-chain metadata: image, banner, socials) ──
  profileMaxImageBytes: num("PROFILE_MAX_IMAGE_BYTES", 800 * 1024), // per STORED image (after server downscale)
  profileMaxUploadBytes: num("PROFILE_MAX_UPLOAD_BYTES", 16 * 1024 * 1024), // per RAW upload the server will convert (HEIC photos are a few MB)
  profileMaxPixels: num("PROFILE_MAX_PIXELS", 40_000_000),         // reject decompression-bomb images before decode (~40MP; a big phone photo is ~12MP)
  profileDecodeTimeoutMs: num("PROFILE_DECODE_TIMEOUT_MS", 5000),  // cap one image decode/convert so a pathological upload can't wedge the loop
  profilePfpDim: num("PROFILE_PFP_DIM", 400),                      // server downscales the pfp to fit this box
  profileBannerDim: num("PROFILE_BANNER_DIM", 1200),               // …and the banner to this
  profileMaxSigAgeSecs: num("PROFILE_MAX_SIG_AGE", 600),            // reject signatures older/newer than this skew

  // ── rewards (RewardVault merkle poster) ──
  rewardVault: (process.env.REWARD_VAULT || "").toLowerCase(), // "" disables Accrued indexing + posting
  epochLen: num("EPOCH_LEN", 7 * 24 * 3600),                   // MUST match RewardVault.EPOCH (7d default)
  finalityDelay: num("FINALITY_DELAY", 0),                     // MUST match RewardVault.finalityDelay (reorg gate)
  challengeWindow: num("CHALLENGE_WINDOW", 2 * 24 * 3600),     // = RewardVault.challengeWindow (claims open after this; shown in the UI)
  posterKey: process.env.POSTER_KEY || "",                     // poster private key; "" = compute+persist but don't post on-chain
  rewardUriBase: process.env.REWARD_URI_BASE || "",            // optional: prefix for the pinned leaf-set URI (else self /api URL)
};
