// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Pad - on-chain config (audit this file first)
//
// Everything the front-end needs to talk to the chain lives here, in the open.
// No secrets: RPC keys stay server-side; this file only holds public addresses.
//
// Addresses marked `DEPLOY:` are filled in AFTER we deploy the contracts and
// have verified them on the explorer. Until then the flows that need them stay
// GATED (the UI says "opens at launch") - nothing can silently send a tx to a
// zero / wrong address. See isDeployed().
// ─────────────────────────────────────────────────────────────────────────────

export const CHAIN = {
  id: 4663,
  hexId: "0x1237", // 4663
  name: "Robinhood Chain",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Read RPC. ONLY the indexer read-proxy: it serves reads from the paid Alchemy RPC
  // server-side (with its own failover to a backup key + Blockscout) and a short cache.
  // We deliberately do NOT list the public Blockscout endpoint here as a browser fallback:
  // it rate-limits (429) every browser and ethers then retries it forever, hanging reads.
  // The proxy already does all failover server-side, so one reliable endpoint is correct.
  // (Writes never use this - wallets broadcast their own txs through the user's own RPC.)
  rpc: ["https://api.robinlab.io/rpc"],
  // RPC given to the WALLET when adding the chain (wallet_addEthereumChain). MUST be a
  // full, write-capable endpoint - the wallet broadcasts the user's txs through it - so
  // it must NEVER include the read-only /rpc proxy (which refuses eth_sendRawTransaction).
  walletRpcUrls: ["https://robinhoodchain.blockscout.com/api/eth-rpc"],
  explorer: "https://robinhoodchain.blockscout.com",
};

export const CONTRACTS = {
  // Known infrastructure on Robinhood Chain (the same addresses the fork tests
  // run against - real Uniswap v3 + WETH, not mocks).
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",

  // Our CurvePadFactory (one-call launch) - LIVE on Robinhood Chain.
  padFactory: "0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074",

  // Our PadRouter - the swap desk + project fee. Robinhood Chain has no canonical
  // Uniswap periphery, so THIS is the router every trade goes through - LIVE.
  padRouter: "0xA6BaAB820809C7fC8350311776627298f91F07eC",

  // Our FeeConfig - the single owner-governed fee dial (LP creator split + swap platform/creator/floor split).
  // Curves + router read it on-chain; the owner retunes it with a setter (no redeploy). LIVE.
  feeConfig: "0x064D977B66FCC29256510dBCD8cC0C51bBb2De14",

  // Our RewardVault - custodies the additive 0.25% trader + 0.25% holder legs and
  // pays capped, Merkle-proven claims in real ETH. LIVE: router.setRewardVault wired
  // to this address, so the reward legs are on for every trade.
  rewardVault: "0x03d5d26E492B288e62D897E7dde91af3CceB4347",

  // Our TokenVestingLock - one shared, IRREVOCABLE locker holding many creator dev-bag schedules
  // (cliff + linear). LIVE: creators opt in by locking their own tokens; UI/SDK paths active.
  tokenVestingLock: "0x7453856c3E5f6832dc660e48c7Daa6f46f3355DF",

  // Our FloorCoopFactory - deploys a per-coin community floor vault (add to the buy-wall, earn dip-buy
  // fees, withdrawable after a cooldown). LIVE.
  floorCoopFactory: "0x564EDF561Bed46C972d5D44D84f5FAc9C5118668",

  // Our PlatformFeeSplitter - routes the platform's cut ($ROBIN buyback split). Standalone; used by the
  // admin panel to read/set the split. Key MUST be `splitter` to match ADMIN_ABI.splitter and admin.html.
  splitter: "0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a",

  // RobinLimit - non-custodial limit orders + DCA, routing through the LIVE padRouter. Deployed
  // 2026-07-28; owner = the cold wallet. Setting this address turns on the profile "Automations" UI;
  // the keeper (indexer) must also run with ROBIN_LIMIT set for orders to fill.
  robinLimit: "0xe1d37524E2992Aeb8943B229c42293264c8fA99C",

  // The platform's buy-back token + its WETH pool (for links / a future buy widget).
  // The above-default fee's 25% cut is paid to the platform, which buys+burns the
  // platform token off-chain - the router does not swap it on-chain. TBD for Robin Labs.
  platformToken: "",
  platformPool: "",

  // Multicall3 - the canonical read-batcher (same address on nearly every EVM chain;
  // verified deployed on Robinhood Chain). Used to collapse many independent view reads
  // (e.g. a portfolio's balanceOf fan-out) into ONE eth_call, cutting RPC load. Reads only.
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

// 1% pool tier - the fee is collected as Uniswap LP fees IN-PROTOCOL. There is
// never a separate fee-transfer instruction bolted onto a user's tx (Rule 3).
export const POOL_FEE = 10000;

export const TOTAL_SUPPLY = 1_000_000_000n; // whole tokens (18 decimals added on-chain)
// (the dev's opening buy is uncapped - it climbs the curve up to the graduation ceiling and refunds any excess)
export const DEFAULT_FEE_BPS = 100; // the baseline 1% every coin pays (also the floor)
export const MAX_TAX_BPS = 400; // contract-enforced 4% cap per side
export const EXCESS_PLATFORM_BPS = 2500; // 25% of the ABOVE-default fee → platform buy-back

// Gas headroom we require ON TOP of a tx's value before we ever ask a wallet to
// sign, so the wallet never shows its red "insufficient funds / blocked" screen
// (Rule: guard BEFORE signing). ~0.0008 ETH is generous for an L2.
export const GAS_BUFFER_WEI = 800_000_000_000_000n; // 0.0008 ETH

// Minimal ABIs (human-readable - ethers parses these). We deliberately keep the
// surface tiny and readable instead of pasting giant JSON blobs.
export const ABIS = {
  // Our launch entrypoint. Payable: any ETH sent is the dev's OWN opening buy
  // (≤2%), executed atomically before trading opens. Carries the project's tax.
  padFactory: [
    "function launch((string name, string symbol, address dev, (uint16 buyBps, uint16 sellBps, uint16 walletBps, uint16 floorBps, uint16 burnBps, address projectWallet) tax) p) payable returns (address token, address curve, address pool)",
    "function tokenCount() view returns (uint256)",
    "function allTokens(uint256) view returns (address)",
    "function recordOf(address) view returns (address token, address curve, address dev, uint256 at)",
    "event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)",
  ],
  // Our PadRouter. Buys send native ETH (no approval); sells need one exact-amount
  // approval to the router. The tax split happens inside - no side transfers.
  padRouter: [
    "function buy(address token, uint256 minOut) payable returns (uint256 tokensOut)",
    "function sell(address token, uint256 amountIn, uint256 minOutEth) returns (uint256 ethOut)",
    "function configOf(address token) view returns ((address pool, address curve, address projectWallet, uint16 buyBps, uint16 sellBps, uint16 walletBps, uint16 floorBps, uint16 burnBps, bool set))",
    "function devEscrow(address) view returns (uint256)",
    "function bondOf(address) view returns (address)",
    "function withdrawDev(address token)",
    "function burnDev(address token)",
  ],
  // Our RewardVault - capped, Merkle-proven claims for the 0.25% trader/holder legs.
  // The claim is a pure verify + capped ETH transfer; the indexer serves the proof.
  rewardVault: [
    "function claim(uint256 epoch, address coin, uint8 side, uint256 amount, bytes32[] proof)",
    "function pot(address coin, uint256 epoch) view returns (uint128 traderPot, uint128 holderPot)",
    "function currentEpoch() view returns (uint256)",
    "function EPOCH() view returns (uint256)",
    "event Claimed(uint256 indexed epoch, address indexed coin, address indexed user, uint8 side, uint256 amount)",
  ],
  // TokenVestingLock - creator dev-bag vesting (cliff + linear). `create` needs a prior EXACT-amount
  // ERC20 approve; `schedules(id)` feeds the countdown/beneficiary, the views feed the badge.
  tokenVestingLock: [
    "function create(address token, address beneficiary, uint256 amount, uint64 start, uint64 cliffDuration, uint64 duration) returns (uint256 id)",
    "function release(uint256 id) returns (uint256 amount)",
    "function releasable(uint256 id) view returns (uint256)",
    "function locked(uint256 id) view returns (uint256)",
    "function lockedPercent(uint256 id) view returns (uint256)",
    "function idsOfBeneficiary(address who) view returns (uint256[])",
    "function idsOfToken(address token) view returns (uint256[])",
    "function schedules(uint256) view returns (address token, address beneficiary, uint128 total, uint128 released, uint64 start, uint64 cliff, uint64 duration)",
    "event ScheduleCreated(uint256 indexed id, address indexed token, address indexed beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration)",
  ],
  // Community floor vault: add ETH to the below-price buy-wall, earn dip-buy fees, withdraw after cooldown.
  floorCoopFactory: [
    "function coopOf(address token) view returns (address)",
    "function createCoop(address token) returns (address)",
  ],
  floorCoop: [
    "function WETH() view returns (address)",
    "function totalShares() view returns (uint256)",
    "function shares(address) view returns (uint256)",
    "function pos(address) view returns (uint256 shares, uint256 weight, uint256 multBps, uint256 lockUntil)",
    "function pending(address user) view returns (uint256 wethOwed, uint256 tokenOwed)",
    "function totalNav() view returns (uint256)",
    "function deposit(uint256 lockDays, uint256 minSharesOut) payable returns (uint256 sharesMinted)",
    "function withdraw(uint256 shareAmt, uint256 minWethOut, uint256 minTokenOut) returns (uint256 wethOut, uint256 tokenOut)",
    "function claim()",
    "function compound()",
    "function sweepProtocol()",
  ],
  // The CurvePool - the bonding curve + graduation. Read progress, drive the
  // graduate button + curve geometry for the progress bar. Graduation is ceiling-only (~4.2 ETH):
  // `ready()` flips true only when the tick reaches gradTick, and `graduate()` is permissionless.
  curve: [
    "function pool() view returns (address)",
    "function dev() view returns (address)",
    "function bond() view returns (address)",
    "function seeded() view returns (bool)",
    "function graduated() view returns (bool)",
    "function ready() view returns (bool)",
    "function seedTime() view returns (uint64)",
    "function startTick() view returns (int24)",
    "function gradTick() view returns (int24)",
    "function graduate()",
    "function collectFees() returns (uint256 wethFees, uint256 tokenFees)",
  ],
  erc20: [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function totalSupply() view returns (uint256)",
  ],
  pool: [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIdx, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
  ],
  // Multicall3 read-batcher. aggregate3 runs every subcall in one block context with per-call
  // allowFailure, so one bad target can't sink the batch. We only ever eth_call this (reads).
  multicall3: [
    "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
  ],
  // RobinLimit — non-custodial limit orders + DCA. The Order tuple must match the contract's struct order.
  robinLimit: [
    "function hashOrder((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o) view returns (bytes32)",
    "function cancel((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o)",
    "function filledSlices(bytes32) view returns (uint256)",
    "function remainingSlices((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o) view returns (uint256)",
    "function execute((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o, bytes signature) returns (uint256)",
  ],
};

// ── Admin ABIs (owner/poster/guardian surface) ──────────────────────────────
// Used ONLY by admin.html. Every action is gated on-chain (onlyOwner / poster / guardian), so exposing these
// in a public page is safe: a non-owner's tx simply reverts. Views let the panel show balances + status.
export const ADMIN_ABI = {
  padRouter: [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function platformEscrow() view returns (uint256)",
    "function platformCutEscrow() view returns (uint256)",
    "function floorEscrow(address) view returns (uint256)",
    "function deferredEscrow(address) view returns (uint256)",
    "function burnEscrow(address) view returns (uint256)",
    "function isFactory(address) view returns (bool)",
    "function rewardVault() view returns (address)",
    "function withdrawPlatform()",
    "function withdrawPlatformCut()",
    "function flushFloor(address token)",
    "function claimDeferred(address token)",
    "function flushBurn(address token)",
    "function rescueUngraduated(address token)",
    "function setFactory(address f)",
    "function removeFactory(address f)",
    "function setRewardVault(address v)",
    "function transferOwnership(address newOwner)",
    "function acceptOwnership()",
  ],
  padFactory: [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function platform() view returns (address)",
    "function setPlatform(address p_)",
    "function seedBlocklist(address token, address[] bots)",
    "function transferOwnership(address newOwner)",
    "function acceptOwnership()",
  ],
  rewardVault: [
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function poster() view returns (address)",
    "function guardian() view returns (address)",
    "function currentEpoch() view returns (uint256)",
    "function EPOCH() view returns (uint256)",
    "function finalityDelay() view returns (uint64)",
    "function challengeWindow() view returns (uint64)",
    "function claimWindow() view returns (uint64)",
    "function epochRoot(uint256) view returns (bytes32 root, bytes32 algoHash, uint64 postedAt, uint64 challengeWindow, uint64 claimWindow, bool vetoed)",
    "function pot(address coin, uint256 epoch) view returns (uint128 traderPot, uint128 holderPot)",
    "function setPoster(address p)",
    "function setGuardian(address g)",
    "function setFinalityDelay(uint64 d)",
    "function setChallengeWindow(uint64 w)",
    "function setClaimWindow(uint64 w)",
    "function veto(uint256 epoch)",
    "function sweep(uint256 epoch, address coin)",
    "function transferOwnership(address newOwner)",
    "function acceptOwnership()",
  ],
  floorCoopFactory: [
    "function owner() view returns (address)",
    "function treasury() view returns (address)",
    "function coopOf(address token) view returns (address)",
    "function setTreasury(address t)",
    "function transferOwnership(address newOwner)",
  ],
  floorCoop: ["function sweepProtocol()", "function protocolWeth() view returns (uint256)", "function protocolToken() view returns (uint256)"],
  splitter: [
    "function owner() view returns (address)",
    "function robinSink() view returns (address)",
    "function robinShareBps() view returns (uint16)",
    "function platformTreasury() view returns (address)",
    "function setRobinShareBps(uint16 bps)",
    "function setRobinSink(address sink)",
    "function setPlatformTreasury(address t)",
    "function transferOwnership(address newOwner)",
  ],
  feeConfig: [
    "function owner() view returns (address)",
    "function lpCreatorBps() view returns (uint16)",
    "function swapPlatformBps() view returns (uint16)",
    "function swapCreatorBps() view returns (uint16)",
    "function swapFloorBps() view returns (uint16)",
    "function setLpCreatorBps(uint16 bps)",
    "function setSwapSplit(uint16 platformBps, uint16 creatorBps, uint16 floorBps)",
  ],
};

// ── Optional indexer/API (see /indexer) ─────────────────────────────────────
// When set to your indexer host (e.g. "https://api.robinlab.io"), the browse
// feed, search, trending/top sorting and per-coin trade history come from the
// API in ONE request instead of fanning out dozens of RPC calls per page. Leave
// "" and everything falls back to reading the chain directly - the pad works
// either way, the API just makes it fast. No secrets here; the API is read-only.
export const API_BASE = "https://api.robinlab.io";

// Platform owner (cold wallet). ONLY used to reveal the discreet "Admin" nav link when this wallet connects -
// every admin action is enforced on-chain by onlyOwner regardless, so this is pure convenience, not auth.
export const OWNER = "0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf";

// ── GoPlus token-security (see /assets/safety.js) ───────────────────────────
// GoPlus supports Robinhood Chain (4663), so our coins get the same honeypot/tax/mint scan wallets use.
// The token_security endpoint works WITHOUT a key (rate-limited); an optional app-key raises the limit.
// No secret risk if set - it's a public read key - but leave "" to use the free anon tier.
export const GOPLUS_APP_KEY = "";

export const isDeployed = (key) => /^0x[0-9a-fA-F]{40}$/.test(CONTRACTS[key] || "");
export const hasApi = () => /^https?:\/\//.test(API_BASE || "");

// ── Uniswap Trading API top-token swaps (via the indexer key-proxy) ──────────
// The biggest LIVE tokens on Robinhood Chain trade through OUR server-side proxy
// (/api/uni/*), which injects the Uniswap key + our 1.25% fee and allowlists the
// chain + these tokens. NO secret here - the key never leaves the server; this is
// just the public token list the swap UI offers. The server allowlist is the real
// authority (indexer UNISWAP_TOKENS); this mirrors it so the picker reads full.
// Whether the desk is actually live is feature-detected at runtime (Pad.uniLive()),
// since it only turns on once the operator sets UNISWAP_API_KEY on the indexer.
export const UNI_NATIVE = "0x0000000000000000000000000000000000000000"; // Trading API native-ETH sentinel
export const UNI_TOKENS = [
  "0x020bfc650a365f8bb26819deaabf3e21291018b4", "0x0339f5459fc690ac85f1782e15782a151b4a9e1b",
  "0x45f82ac5d507e988f7406935da8eefe495a360e0", "0x1541b925f0948c6d91be8b52320687ba62d30b64",
  "0x499dc58539ba6869ee15b6c2a3c3c07f1ac4995f", "0x2286397228be256529be1ae9ed8d7d16549e9c6a",
  "0x9e94c8b5a0caeda5d0471c3a9f5ed4f3519d88c7", "0x5266eeaff092d6136ab63d18b975a60a0cc0c8f7",
  "0x8f100e99ddf699320724e37cb866770381d47382", "0xc42cf61c16aac797b991cf9c1ac8ae70ba74a286",
  "0x38bb87cf3e7344a82be7cd671c191f015b97eee6", "0x86e5ac7ec60eeec0a8989f1f1d617ae18c15fa0c",
  "0x41f41f7b849a25e027876c485544c8088f447a11",
];
export const UNI_FEE_BPS = 125; // our 1.25%/side integrator fee (matches the server); shown to the user, taken in-swap
export const isUniToken = (a) => UNI_TOKENS.includes(String(a || "").toLowerCase());
