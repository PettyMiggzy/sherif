// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — pad-v4 (no-pool-forever rewrite) TESTER DEVNET config
//
// Points at a Hardhat node running on the team's droplet (a fork of Robinhood Chain — real
// chainId 4663, cheat-codes like hardhat_setBalance enabled — running pad-v4's OWN fresh
// contracts, not the real deployed ones; see pad-v4/scripts/deploy-local-demo.js). It exists so
// the pad-v4 no-pool-forever preview pages make REAL contract calls against a REAL deployment
// while pad-v4 itself is still pre-testnet R&D (see pad-v4/NO-POOL-FOREVER.md status). Addresses
// below come straight out of that deploy script's output (pad/js/deploy.local.json) — regenerate
// that file and this one stays in sync automatically via loadDeployment() below; nothing here is
// hand-typed.
//
// DO NOT point this file at a real network. MockPermit2/MockPositionManagerV4 (used in the local
// deploy so pad-v4 doesn't need the real, differently-pinned-solc Uniswap v4 periphery) are not
// real custody, and the local node's accounts are Hardhat's publicly-known dev keys — anyone can
// spend from them. This is for internal team testing only; don't publicize the RPC URL.
// ─────────────────────────────────────────────────────────────────────────────

export const CHAIN = {
  id: 4663,
  hexId: "0x1237",
  name: "Robinhood Chain (pad-v4 tester devnet)",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // HTTPS via Caddy reverse-proxying test.robinlab.io/rpc -> localhost:8545 on the droplet — a plain
  // http:// RPC URL (what this pointed at before) is rejected outright by MetaMask MOBILE when adding
  // a custom network (the desktop extension is more lenient). Same-origin with the pad pages served
  // from the same domain, so no CORS config is needed either.
  rpc: ["https://test.robinlab.io/rpc"],
  walletRpcUrls: ["https://test.robinlab.io/rpc"],
  explorer: "",
};

let _deployment = null;
/// Fetch pad-v4/scripts/deploy-local-demo.js's manifest. Throws a clear, catchable error if the
/// local devnet hasn't been deployed to yet — callers show that as "not connected", not a crash.
export async function loadDeployment() {
  if (_deployment) return _deployment;
  const res = await fetch("./js/deploy.local.json", { cache: "no-store" });
  if (!res.ok) throw new Error("deploy.local.json not found — run scripts/deploy-local-demo.js first");
  _deployment = await res.json();
  return _deployment;
}

export const ABIS = {
  erc20: [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function totalSupply() view returns (uint256)",
  ],
  curve: [
    "function ready() view returns (bool)",
    "function graduated() view returns (bool)",
    "function noPoolForever() view returns (bool)",
    "function visibilityWithdrawBps() view returns (uint16)",
    "function startTick() view returns (int24)",
    "function gradTick() view returns (int24)",
    "function creator() view returns (address)",
    "function creatorEthOwed() view returns (uint256)",
    "function platformEthOwed() view returns (uint256)",
    "function graduate()",
  ],
  factory: [
    "function launchCount() view returns (uint256)",
    "function launches(uint256) view returns (address token, address hook, address curve, bytes32 poolId)",
    "function poolOf(address token) view returns (bytes32)",
  ],
  stateView: [
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  ],
  poolSwapTest: [
    "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, (bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params, (bool takeClaims,bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256)",
  ],
  burnTracker: [
    "function burn(address token, uint256 amount)",
    "function burnedBy(address token, address account) view returns (uint256)",
    "function totalBurned(address token) view returns (uint256)",
  ],
};

// Uniswap v4 TickMath sqrt price bounds — needed as swap price limits (PoolSwapTest requires one).
export const MIN_SQRT_LIMIT = 4295128739n + 1n;
export const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
