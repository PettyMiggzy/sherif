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

/// Dedupe while preserving order — the same URL configured twice must not become two providers.
const uniq = (list) => list.filter((u, i, a) => u && a.indexOf(u) === i);

export const CFG = {
  rpcUrl: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  // Upstream fallback for the /rpc read-proxy if the primary (paid) RPC errors.
  rpcFallback: process.env.RPC_FALLBACK || "https://robinhoodchain.blockscout.com/api/eth-rpc",
  // Optional BACKUP RPC (e.g. a QuikNode/paid endpoint, key in URL = SECRET, keep in .env). When set
  // and distinct from RPC_URL it becomes a priority-2 backstop for BOTH the core poller (failover so a
  // primary outage doesn't stall indexing) and the /rpc proxy (tried before the blockscout fallback).
  // Blank (default) = no change: single primary provider, exactly as before. Reads only; the poster
  // always signs/broadcasts on RPC_URL.
  rpcBackup: (process.env.RPC_BACKUP || "").trim(),
  // FREE endpoints, tried BEFORE the paid one on every read. This is the whole point: the paid RPC becomes a
  // backstop for when the free ones stall or error, instead of being the thing that answers every call.
  // Comma-separated; order is the order they are tried. Set RPC_FREE="" to go back to paid-first.
  rpcFree: (process.env.RPC_FREE ?? "https://rpc.mainnet.chain.robinhood.com")
    .split(",").map((u) => u.trim()).filter(Boolean),
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
  // TWO ROUTERS ARE LIVE AT ONCE. A coin is bound to the router it launched under and never moves, so v1
  // keeps serving every coin launched before the v2 deploy while v2 serves everything since. Anything that
  // reads router EVENTS has to watch both or it silently mis-attributes half the pad: a pad-routed trade
  // arrives at the pool with the ROUTER as recipient, and the actor is only corrected back to the real
  // wallet for a router this list knows. Miss one and those trades are credited to a contract address.
  // ROUTERS overrides the list outright. Otherwise it is the union of `router` and `stakingRouter`, so
  // setting ROUTER alone still governs -- a config that names one router must never be silently ignored
  // in favour of a hardcoded pair.
  routers: [...new Set(
    (process.env.ROUTERS
      ? process.env.ROUTERS.split(",")
      : [process.env.ROUTER || "0xA6BaAB820809C7fC8350311776627298f91F07eC",
         process.env.STAKING_ROUTER || "0x7e3BbfddFd8B18b789710a6E419B12Dee1E9B9b1"]
    ).map((s) => s.trim().toLowerCase()).filter(Boolean),
  )],
  // The router that carries the staking/$ROBIN sinks. ONLY v2 has them -- v1 predates the feature and
  // reverts on `stakingSink()`, which is not a misconfiguration to route around, it is the older contract
  // being older. The fee sweeper must talk to this one, never to `router` above.
  stakingRouter: (process.env.STAKING_ROUTER || "0x7e3BbfddFd8B18b789710a6E419B12Dee1E9B9b1").toLowerCase(),
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
  // Tokenized stocks, which trade through the same proxy but must NEVER carry our integrator fee.
  //
  // Not a preference — a structural rule. Taking a cut of somebody's trade in a tokenized security is what
  // turns a front end into a fee-taking venue for securities, which is the thing RobinStockSwap's own header
  // warns about at length. Listing them costs nothing and earns nothing: the fee is simply not requested on
  // these pairs, and `uniproxy` refuses any upstream answer that came back carrying one.
  //
  // Defaults to the six in pad/assets/config.js STOCKS. Override with UNISWAP_STOCK_TOKENS to add more.
  uniStockTokens: (process.env.UNISWAP_STOCK_TOKENS ||
    [
      "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", // SGOV
      "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", // AAPL
      "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVDA
      "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", // TSLA
      "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", // SPCX
      "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", // SPY
    ].join(",")
  ).split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
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

  // ── Text-to-art proxy (describe a coin, get its artwork) ──
  // /api/art is OFF unless VENICE_API_KEY is set. The key is a SECRET (gitignored .venice_key /
  // .env) injected server-side so it NEVER reaches the browser — pad/ is a static site served
  // straight off disk, so anything referenced from there is readable in View Source.
  //
  // THE MODEL IS A PRICE. Venice's image catalogue runs $0.01 to $0.29 per image and includes
  // adult-tuned models, so it is set here and never read from a request body. venice-sd35 is the
  // $0.01 tier and the default; the spend ceiling is veniceGlobalPerMin x that price.
  veniceApiKey: process.env.VENICE_API_KEY || "",
  veniceApiBase: (process.env.VENICE_API_BASE || "https://api.venice.ai/api/v1").replace(/\/+$/, ""),
  // THREE TIERS, and the client only ever names the tier. Which model serves it is a cost and a
  // supplier relationship, never a product feature — see artproxy.js. Prices below are what the
  // provider charges us per image, measured, not quoted:
  //   standard  venice-sd35         $0.01   sold at 2 credits ($0.20)
  //   medium    nano-banana-2 1K    $0.10   sold at 3 credits ($0.30)
  //   high      nano-banana-pro 1K  $0.18   sold at 6 credits ($0.60)
  //
  // ALL TIERS RENDER AT 1K AND THAT IS NOT A COMPROMISE. Every result is downscaled to
  // veniceOutPx (512) before it leaves this process, because the output is a coin avatar that
  // renders as a 40px circle. Buying 2K at $0.23 to then throw four fifths of it away is $0.05 an
  // image of nothing. Raise veniceOutPx first if that ever stops being true.
  //
  // Charging also costs GAS: one spendWithSig per image, ~85.3k gas, paid by the operator. At the
  // measured 0.057 gwei on this chain that is ~$0.015 per image at $3k ETH — real money against a
  // $0.20 sale, and it is charged whether or not the generation was any good.
  // nano-banana-2-lite ($0.06) is deliberately NOT used: measured one solid-black result in three,
  // billed in full, which makes it both dearer and less reliable than the $0.01 standard model.
  veniceModelStandard: process.env.VENICE_MODEL_STANDARD || "venice-sd35",
  veniceModelMedium: process.env.VENICE_MODEL_MEDIUM || "nano-banana-2",
  veniceModelHigh: process.env.VENICE_MODEL_HIGH || "nano-banana-pro",
  veniceCreditsStandard: num("VENICE_CREDITS_STANDARD", 2),
  veniceCreditsMedium: num("VENICE_CREDITS_MEDIUM", 3),
  veniceCreditsHigh: num("VENICE_CREDITS_HIGH", 6),
  veniceResolution: process.env.VENICE_RESOLUTION || "1K",
  veniceSteps: num("VENICE_STEPS", 25),                  // venice-sd35 caps at 30
  veniceOutPx: num("VENICE_OUT_PX", 512),                // 1024 PNG in (~2.1MB), 512 webp out
  veniceRatePerSec: num("VENICE_RATE_PER_SEC", 1),       // per-IP: generation is slow and costs money
  // TOTAL images/min across every IP — the hard spend bound. At the $0.01 default this is 10c/min
  // worst case; raise it only alongside the model price you are actually paying.
  veniceGlobalPerMin: num("VENICE_GLOBAL_PER_MIN", 10),
  veniceMaxPromptChars: num("VENICE_MAX_PROMPT_CHARS", 600),
  // ── Fee keeper (walks fees from the router into stakers' hands) ──
  // Money does NOT flow on its own: a trade accrues it in the router and stops there. Three calls
  // have to happen afterwards — flushStaking / flushRobin, feedEth, releasePending — and nothing in
  // the system makes any of them until this keeper runs. OFF unless all four are set.
  //
  // feedKeeperKey is a low-value hot key: it can only move fees along a path whose destinations are
  // fixed in the contracts (the router's sinks are owner-set, the feeder can only pay registry
  // pools), so it chooses TIMING, never destination.
  feedKeeperKey: process.env.FEED_KEEPER_KEY || "",
  // Reuses the router already configured above; the flagship $ROBIN token is where the buy-side
  // slice lands, so it has to be known to resolve that pool.
  platformToken: (process.env.PLATFORM_TOKEN || "0x6696fe29288b586017e6f264c0091dba6c5ebeaf").toLowerCase(),
  stakingFeeder: process.env.STAKING_FEEDER || "",
  feedIntervalMs: num("FEED_INTERVAL_MS", 30 * 60 * 1000),
  // Below this an accrued slice is left to keep accruing — gas on a flush plus a feed is worth more
  // than a few thousand wei of reward.
  feedMinWei: BigInt(process.env.FEED_MIN_WEI || "1000000000000000"), // 0.001 ETH

  // ── Auto pool-maker (every bonded coin gets a staking pool) ──
  // OFF unless BOTH are set. The keeper creates the pool AFTER graduation, in its own transaction —
  // never inside graduate(), which is the one function that must never fail because a revert there
  // strands the coin's whole raise with no rescue path.
  //
  // poolMakerKey needs a CREATOR slot on the factory (setCreator(keeper, true)). That slot is
  // permission to ADD a pool to the registry and nothing else — pools are owned by the factory's
  // owner — so this key cannot configure rewards, change the boost, or touch anyone's stake. Keep it
  // funded with gas and treat it as disposable.
  tierStakingFactory: process.env.TIER_STAKING_FACTORY || "",
  poolMakerKey: process.env.POOL_MAKER_KEY || "",
  poolBackfillMs: num("POOL_BACKFILL_MS", 15 * 60 * 1000),

  // ── Robin Labs AI (the pad's chat) ──
  // /api/chat is OFF unless GROQ_API_KEY is set. The key is a SECRET (gitignored .groq_key / .env)
  // injected server-side so it NEVER reaches the browser — pad/ is a static site served straight off
  // disk, so anything referenced from there is readable in View Source.
  //
  // RATE LIMITS ARE PER MODEL, NOT PER ACCOUNT. Measured on this key, not read off a page:
  //
  //   openai/gpt-oss-120b   8K tokens/min, 200K/day, 1000 req/day
  //     ~2,300 tokens a message at 3000 chars of context => ~3 msgs/min, ~86 msgs/day.
  //     Predictable and grounded. THE DEFAULT.
  //
  //   groq/compound         70K tokens/min, 250 req/day, no daily token cap
  //     ~5,900 tokens a message — it is an AGENTIC system that adds its own scaffolding and can
  //     reach the web — so despite the far larger budget it costs 2.5x per answer. Nets ~11
  //     msgs/min and ~250 msgs/day, roughly 3x the daily volume. Two catches: it rejects anything
  //     over ~1500 chars of context with a 413, and because it can search the web it will answer
  //     from OUTSIDE our docs. Asked how to launch, it invented a "Create New Coin" button we do
  //     not have. For a support bot whose whole value is being right about OUR product, that is the
  //     wrong trade — but it is one env var away if volume matters more than precision:
  //       GROQ_MODEL=groq/compound  CHAT_CONTEXT_MAX_CHARS=1500
  //
  // Either way the free tier is soft-launch capacity. There is no code change that fixes that.
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqApiBase: (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  // THE POOL. Rate limits are per model, so several models are several budgets: these four carry
  // 8K tokens/minute EACH (32K combined) and their daily allowances differ by an order of magnitude,
  // so rotating spreads both ceilings. Least-recently-used first; a 429 parks that model for exactly
  // as long as the provider's retry-after says and the next one serves the request.
  //
  // groq/compound is NOT in here despite a 70K/min budget: it is agentic, can reach the web, and
  // answers from outside our docs. Set GROQ_MODELS explicitly if you want it.
  // qwen3.6-27b is deliberately absent. Vetted individually before shipping, it returned its raw
  // chain of thought inline on every answer — and on a prompt-injection attempt that monologue is
  // the model reasoning about its own instructions, out loud, to the person trying to extract them.
  // stripThinking() defends against it anyway, because the next model to do this will not announce
  // itself, but a model that needs the defence on every single reply does not belong in the pool.
  groqModels: (process.env.GROQ_MODELS
    || "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b")
    .split(",").map((s) => s.trim()).filter(Boolean),
  // Where docs.html and SECURITY.md live. Tried before the built-in fallbacks, because the indexer
  // does not always sit next to the site — in the container only the web server mounts pad/.
  docsRoot: process.env.DOCS_ROOT || "",
  chatDocsMaxChars: num("CHAT_DOCS_MAX_CHARS", 60000),
  // Docs sent per question. Measured against the default model: 6000 chars = 2,968 tokens a message
  // (67/day), 3000 = 2,306 (86/day), 1500 = 1,848 (108/day). Diminishing, because the persona and
  // the verified primer are a ~1,000-token floor that does not shrink. 3000 keeps answers deep
  // enough to be worth asking.
  chatContextMaxChars: num("CHAT_CONTEXT_MAX_CHARS", 3000),
  chatContextMaxSections: num("CHAT_CONTEXT_MAX_SECTIONS", 3),
  chatMaxTurns: num("CHAT_MAX_TURNS", 12),              // how much history is forwarded
  chatMaxCharsPerTurn: num("CHAT_MAX_CHARS_PER_TURN", 2000),
  chatMaxReplyTokens: num("CHAT_MAX_REPLY_TOKENS", 600),
  chatRatePerSec: num("CHAT_RATE_PER_SEC", 1),
  chatGlobalPerMin: num("CHAT_GLOBAL_PER_MIN", 60),
  chatCorsOrigins: (process.env.CHAT_CORS_ORIGINS || "https://robinlab.io,https://www.robinlab.io,https://robinlabs.fun,https://www.robinlabs.fun")
    .split(",").map((s) => s.trim()).filter(Boolean),

  // ── Art credits (the paywall in front of /api/art) ──
  // Both must be set or the generator stays FREE and rate-limited. artOperatorKey is a SECRET, and
  // deliberately a low-value one: ArtCredits requires the customer's own signature on every spend,
  // so this key can only relay an authorisation somebody already gave. It cannot mint credits,
  // spend them unbidden, move ETH, or reprice anything. Keep it funded with a little gas and
  // nothing else.
  artCredits: process.env.ART_CREDITS || "",
  artOperatorKey: process.env.ART_OPERATOR_KEY || "",

  veniceCorsOrigins: (process.env.VENICE_CORS_ORIGINS || "https://robinlab.io,https://www.robinlab.io,https://robinlabs.fun,https://www.robinlabs.fun")
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

// ── the read order, used by BOTH the poller and the /rpc proxy ───────────────
// Free first, the paid RPC as the backstop, Blockscout last.
//
// Blockscout is free too, but it is deliberately NOT in the free tier: it rate-limits hard, and this
// indexer's heaviest call is a burst of one getLogs per pool. Putting it ahead of the paid endpoint would
// mean 429ing through it on every pass and falling through to the paid one anyway — all of the latency, none
// of the saving. It stays where it is useful: the last resort when everything else is down.
//
// WRITES ARE NOT AFFECTED. The poster and the keepers sign and broadcast on RPC_URL, on purpose — a free
// endpoint that silently drops a raw transaction is a different and much worse failure than a slow read.
CFG.readOrder = uniq([...CFG.rpcFree, CFG.rpcUrl, CFG.rpcBackup, CFG.rpcFallback]);
