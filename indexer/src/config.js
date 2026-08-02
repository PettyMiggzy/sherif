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
  // Optional BACKUP RPC (e.g. a QuikNode/paid endpoint, key in URL = SECRET, keep in .env). When set
  // and distinct from RPC_URL it becomes a priority-2 backstop for BOTH the core poller (failover so a
  // primary outage doesn't stall indexing) and the /rpc proxy (tried before the blockscout fallback).
  // Blank (default) = no change: single primary provider, exactly as before. Reads only; the poster
  // always signs/broadcasts on RPC_URL.
  rpcBackup: (process.env.RPC_BACKUP || "").trim(),
  chainId: num("CHAIN_ID", 4663), // Robinhood Chain; used to pin the FallbackProvider network
  rpcProxy: (process.env.RPC_PROXY ?? "1") !== "0",   // expose POST /rpc (read-only JSON-RPC proxy)
  rpcProxyMaxPerSec: num("RPC_PROXY_MAX_PER_SEC", 40), // per-IP/sec cap on upstream calls (a batch counts by its method count)
  rpcGlobalPerSec: num("RPC_GLOBAL_PER_SEC", 300),     // TOTAL upstream/sec across all IPs, so a third party can't repurpose our read-proxy budget
  apiGetMaxPerSec: num("API_GET_MAX_PER_SEC", 30),     // per-IP/sec cap on GET /api/* reads (cache-bypass DoS guard)
  metaGlobalPerSec: num("META_GLOBAL_PER_SEC", 6),     // TOTAL profile-POST processing/sec across all IPs (pre-auth big-body parse DoS bound)
  mediaMaxPerSec: num("MEDIA_MAX_PER_SEC", 100),       // per-IP/sec cap on /media blob reads. A browse page fires ~40-50 avatar GETs in the first second from one IP; set well above a full page's image count so first-load avatars never 429. Reads are cheap immutable-per-?v blobs already served from MEDIA_CACHE.
  // Defaults match the LIVE pad on Robinhood Chain (pad/assets/config.js padFactory/padRouter), so a
  // fresh deploy indexes the right factory even before .env is filled in. Override via env as needed.
  factory: (process.env.FACTORY || "0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074").toLowerCase(),
  router: (process.env.ROUTER || "0xA6BaAB820809C7fC8350311776627298f91F07eC").toLowerCase(),
  startBlock: num("START_BLOCK", 17752965),
  port: num("PORT", 8787),
  pollMs: num("POLL_MS", 6000),
  chunk: num("CHUNK", 1500),
  confirmations: num("CONFIRMATIONS", 3),
  dbPath: process.env.DB_PATH || resolve(__dir, "..", "data", "robinlabs.db"),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  // Pad origin a shared /coin/:token link bounces a human visitor to (the coin page).
  siteBase: (process.env.SITE_BASE || "https://robinlab.io").replace(/\/+$/, ""),
  // RobinLimit (non-custodial limit orders + DCA) address. "" = the order store + keeper stay OFF
  // (the feature isn't deployed yet). Must match the deployed contract for EIP-712 signature checks.
  robinLimit: (process.env.ROBIN_LIMIT || "").toLowerCase(),
  weth: (process.env.WETH || "0x0bd7d308f8e1639fab988df18a8011f41eacad73").toLowerCase(),

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
  finalityDelay: num("FINALITY_DELAY", 86400),                 // 24h — MUST match RewardVault.finalityDelay (deploy default is 86400)
  challengeWindow: num("CHALLENGE_WINDOW", 2 * 24 * 3600),     // = RewardVault.challengeWindow (claims open after this; shown in the UI)
  posterKey: process.env.POSTER_KEY || "",                     // poster private key; "" = compute+persist but don't post on-chain
  rewardUriBase: process.env.REWARD_URI_BASE || "",            // optional: prefix for the pinned leaf-set URI (else self /api URL)
  holderMinBps: num("HOLDER_MIN_BPS", 2),                      // min time-avg holding to accrue HOLDER rewards, in bps of the 1e9 supply (2 = 0.02%); sub-threshold rolls into the coin's floor. 0 disables the gate
  tokenVestingLock: (process.env.TOKEN_VESTING_LOCK || "").toLowerCase(), // dev vesting-lock singleton — excluded from rewards + ScheduleCreated indexing; "" = not deployed yet

  // ── Uniswap Trading API proxy (top-token swaps) ──
  // The whole /api/uni/* group is OFF unless UNISWAP_API_KEY is set. The key is a SECRET that lives ONLY
  // here (gitignored .env), is injected server-side into the upstream header, and NEVER reaches the browser.
  uniApiKey: process.env.UNISWAP_API_KEY || "",
  uniApiBase: (process.env.UNISWAP_API_BASE || "https://trade-api.gateway.uniswap.org").replace(/\/+$/, ""),
  uniChainId: num("UNISWAP_CHAIN_ID", 4663),
  // Our 1.25%/side integrator fee. Recipient stored lowercased for response comparison + request injection.
  uniFeeRecipient: (process.env.UNISWAP_FEE_RECIPIENT || "0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf").toLowerCase(),
  uniFeeBips: num("UNISWAP_FEE_BIPS", 125),
  // Curated, live-verified tradeable token allowlist (lowercased). Only these + native ETH can be routed.
  uniTokens: (process.env.UNISWAP_TOKENS || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
  uniRatePerSec: num("UNISWAP_RATE_PER_SEC", 2),       // per-IP cap on the proxy
  uniGlobalPerSec: num("UNISWAP_GLOBAL_PER_SEC", 6),   // total upstream/sec cap (shared key budget)
  uniCorsOrigins: (process.env.UNISWAP_CORS_ORIGINS || "https://robinlab.io,https://www.robinlab.io,https://robinlabs.fun,https://www.robinlabs.fun")
    .split(",").map((s) => s.trim()).filter(Boolean),

  // ── Photo-to-meme proxy (turn a snapshot into a coin's meme pfp) ──
  // /api/meme is OFF unless MEME_API_KEY is set. The key is a SECRET (gitignored .env), injected
  // server-side into the provider call and NEVER sent to the browser. Provider-agnostic: defaults
  // to OpenAI's image edit endpoint but any compatible {base, model} works. Spend is bounded by the
  // per-IP + global rate caps below (each image costs a few cents), so a leaked endpoint can't run up a bill.
  memeApiKey: process.env.MEME_API_KEY || "",
  memeApiBase: (process.env.MEME_API_BASE || "https://api.openai.com/v1").replace(/\/+$/, ""),
  memeModel: process.env.MEME_MODEL || "gpt-image-1",
  memeSize: process.env.MEME_SIZE || "1024x1024",
  memeQuality: process.env.MEME_QUALITY || "low",       // low ≈ 2-4c/image on gpt-image-1; "medium"/"high" cost more
  memeRatePerSec: num("MEME_RATE_PER_SEC", 1),          // per-IP cap (image gen is slow + costs money)
  memeGlobalPerMin: num("MEME_GLOBAL_PER_MIN", 20),     // TOTAL images/min across all IPs — the hard spend bound
  memeMaxUploadBytes: num("MEME_MAX_UPLOAD_BYTES", 8 * 1024 * 1024),
  memeCorsOrigins: (process.env.MEME_CORS_ORIGINS || "https://robinlab.io,https://www.robinlab.io,https://robinlabs.fun,https://www.robinlabs.fun")
    .split(",").map((s) => s.trim()).filter(Boolean),

  // ── LI.FI cross-chain proxy (the bridge) ──
  // /api/lifi/* is OFF unless LIFI_API_KEY is set. The key is a SECRET (gitignored .env), injected
  // server-side into the x-lifi-api-key header so it NEVER reaches the browser, which also moves us off
  // the tiny keyless 75-requests-per-2h-per-IP limit onto our per-key bucket (LI.FI's documented fix).
  // One OR MORE LI.FI keys (LIFI_API_KEYS=key1,key2 for round-robin: 2x the per-key 100/min budget + failover;
  // LIFI_API_KEY=key1 also works for a single key). The proxy rotates across them per request.
  lifiApiKeys: (process.env.LIFI_API_KEYS || process.env.LIFI_API_KEY || "").split(",").map((s) => s.trim()).filter(Boolean),
  lifiApiBase: (process.env.LIFI_API_BASE || "https://li.quest/v1").replace(/\/+$/, ""),
  lifiIntegrator: process.env.LIFI_INTEGRATOR || "labs",     // our LI.FI Portal integrator id (fee wallet configured there)
  lifiFee: (process.env.LIFI_FEE || "0.01").trim(),           // our integrator fee fraction (1%); LI.FI forwards it to the Portal wallet
  lifiDestChain: num("LIFI_DEST_CHAIN", 4663),               // destination is always Robinhood Chain
  lifiSrcChains: (process.env.LIFI_SRC_CHAINS || "1,10,56,137,8453,42161").split(",").map((s) => Number(s.trim())).filter(Boolean),
  lifiRatePerSec: num("LIFI_RATE_PER_SEC", 4),               // per-IP cap on the proxy
  lifiGlobalPerSec: num("LIFI_GLOBAL_PER_SEC", 20),          // total upstream/sec cap (protects our per-key budget)
};
