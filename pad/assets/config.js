// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Pad — on-chain config (audit this file first)
//
// Everything the front-end needs to talk to the chain lives here, in the open.
// No secrets: RPC keys stay server-side; this file only holds public addresses.
//
// Addresses marked `DEPLOY:` are filled in AFTER we deploy the contracts and
// have verified them on the explorer. Until then the flows that need them stay
// GATED (the UI says "opens at launch") — nothing can silently send a tx to a
// zero / wrong address. See isDeployed().
// ─────────────────────────────────────────────────────────────────────────────

export const CHAIN = {
  id: 4663,
  hexId: "0x1237", // 4663
  name: "Robinhood Chain",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Read RPCs, in priority order. First is the indexer's read-proxy: it serves reads
  // from the paid RPC server-side with a short cache, so a launch-day crowd hits ONE
  // cached hop instead of each browser hammering the public RPC. The public endpoint is
  // kept as an automatic failover if the proxy is ever unreachable. (Writes never use
  // these — wallets broadcast their own txs through the user's own RPC.)
  rpc: ["https://api.robinlab.io/rpc", "https://robinhoodchain.blockscout.com/api/eth-rpc"],
  // RPC given to the WALLET when adding the chain (wallet_addEthereumChain). MUST be a
  // full, write-capable endpoint — the wallet broadcasts the user's txs through it — so
  // it must NEVER include the read-only /rpc proxy (which refuses eth_sendRawTransaction).
  walletRpcUrls: ["https://robinhoodchain.blockscout.com/api/eth-rpc"],
  explorer: "https://robinhoodchain.blockscout.com",
};

export const CONTRACTS = {
  // Known infrastructure on Robinhood Chain (the same addresses the fork tests
  // run against — real Uniswap v3 + WETH, not mocks).
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",

  // Our CurvePadFactory (one-call launch) — LIVE on Robinhood Chain.
  padFactory: "0xF54032C714e186bC6e5D84230c3B25cAC2e238Ed",

  // Our PadRouter — the swap desk + project fee. Robinhood Chain has no canonical
  // Uniswap periphery, so THIS is the router every trade goes through — LIVE.
  padRouter: "0xCA10a8821aF3D54eA9050A279EDd073654f5Fa1C",

  // Our RewardVault — custodies the additive 0.25% trader + 0.25% holder legs and
  // pays capped, Merkle-proven claims in real ETH. Empty until the reward system
  // ships alongside the next router deploy; the frontend stays inert until it's set.
  rewardVault: "0x5Ca5C1D2D10Bf605F9C42c5Baa0a3f897a3E3811",

  // Our FloorCoopFactory — deploys a per-coin community floor vault (add to the buy-wall, earn dip-buy
  // fees, withdrawable after a cooldown). Empty until it ships with the reward system's deploy.
  floorCoopFactory: "0x2615120ECbe93D5DC5e9268337f42817a3224102",

  // Our PlatformFeeSplitter — routes the platform's cut ($ROBIN buyback split). Standalone; used by the
  // admin panel to read/set the split. Key MUST be `splitter` to match ADMIN_ABI.splitter and admin.html.
  splitter: "0xF56A82476114BDadC425b850d53FEFCb847e7C65",

  // The platform's buy-back token + its WETH pool (for links / a future buy widget).
  // The above-default fee's 25% cut is paid to the platform, which buys+burns the
  // platform token off-chain — the router does not swap it on-chain. TBD for Robin Labs.
  platformToken: "",
  platformPool: "",
};

// 1% pool tier — the fee is collected as Uniswap LP fees IN-PROTOCOL. There is
// never a separate fee-transfer instruction bolted onto a user's tx (Rule 3).
export const POOL_FEE = 10000;

export const TOTAL_SUPPLY = 1_000_000_000n; // whole tokens (18 decimals added on-chain)
// (the dev's opening buy is uncapped — it climbs the curve up to the graduation ceiling and refunds any excess)
export const DEFAULT_FEE_BPS = 100; // the baseline 1% every coin pays (also the floor)
export const MAX_TAX_BPS = 400; // contract-enforced 4% cap per side
export const EXCESS_PLATFORM_BPS = 2500; // 25% of the ABOVE-default fee → platform buy-back

// Gas headroom we require ON TOP of a tx's value before we ever ask a wallet to
// sign, so the wallet never shows its red "insufficient funds / blocked" screen
// (Rule: guard BEFORE signing). ~0.0008 ETH is generous for an L2.
export const GAS_BUFFER_WEI = 800_000_000_000_000n; // 0.0008 ETH

// Minimal ABIs (human-readable — ethers parses these). We deliberately keep the
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
  // approval to the router. The tax split happens inside — no side transfers.
  padRouter: [
    "function buy(address token, uint256 minOut) payable returns (uint256 tokensOut)",
    "function sell(address token, uint256 amountIn, uint256 minOutEth) returns (uint256 ethOut)",
    "function configOf(address token) view returns ((address pool, address curve, address projectWallet, uint16 buyBps, uint16 sellBps, uint16 walletBps, uint16 floorBps, uint16 burnBps, bool set))",
    "function devEscrow(address) view returns (uint256)",
    "function bondOf(address) view returns (address)",
    "function withdrawDev(address token)",
    "function burnDev(address token)",
  ],
  // Our RewardVault — capped, Merkle-proven claims for the 0.25% trader/holder legs.
  // The claim is a pure verify + capped ETH transfer; the indexer serves the proof.
  rewardVault: [
    "function claim(uint256 epoch, address coin, uint8 side, uint256 amount, bytes32[] proof)",
    "function pot(address coin, uint256 epoch) view returns (uint128 traderPot, uint128 holderPot)",
    "function currentEpoch() view returns (uint256)",
    "function EPOCH() view returns (uint256)",
    "event Claimed(uint256 indexed epoch, address indexed coin, address indexed user, uint8 side, uint256 amount)",
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
  // The CurvePool — the bonding curve + graduation. Read progress, drive the
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
};

// ── Optional indexer/API (see /indexer) ─────────────────────────────────────
// When set to your indexer host (e.g. "https://api.robinlabs.io"), the browse
// feed, search, trending/top sorting and per-coin trade history come from the
// API in ONE request instead of fanning out dozens of RPC calls per page. Leave
// "" and everything falls back to reading the chain directly — the pad works
// either way, the API just makes it fast. No secrets here; the API is read-only.
export const API_BASE = "https://api.robinlab.io";

// ── GoPlus token-security (see /assets/safety.js) ───────────────────────────
// GoPlus supports Robinhood Chain (4663), so our coins get the same honeypot/tax/mint scan wallets use.
// The token_security endpoint works WITHOUT a key (rate-limited); an optional app-key raises the limit.
// No secret risk if set — it's a public read key — but leave "" to use the free anon tier.
export const GOPLUS_APP_KEY = "";

export const isDeployed = (key) => /^0x[0-9a-fA-F]{40}$/.test(CONTRACTS[key] || "");
export const hasApi = () => /^https?:\/\//.test(API_BASE || "");
