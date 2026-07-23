// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Pad — JavaScript SDK
//
// One import to read the pad's data: live addresses, typed (human-readable) ABIs,
// and two read clients:
//   • RobinLabsAPI   — the indexer's fast JSON feed (browse, trades, stats, rewards)
//   • RobinLabsChain — direct on-chain reads (no indexer needed; ethers v6 provider)
//
// Zero build. ESM. The API client uses `fetch` only; the chain client needs ethers
// v6 (a peer dependency you pass in). Everything here is READ-ONLY and signs nothing.
//
//   import { RobinLabsChain, ADDRESSES, ABI } from "@robinlabs/pad-sdk";
// ─────────────────────────────────────────────────────────────────────────────

export const CHAIN = {
  id: 4663,
  hex: "0x1237",
  name: "Robinhood Chain",
  currency: "ETH",
  rpc: "https://robinhoodchain.blockscout.com/api/eth-rpc",
  explorer: "https://robinhoodchain.blockscout.com",
  perTxGasCap: 16_777_216, // 2^24 — relevant only if you batch calls in one tx
};

// Live, source-verified deployment (Blockscout + Sourcify, chain 4663).
export const ADDRESSES = {
  curvePadFactory:  "0xF54032C714e186bC6e5D84230c3B25cAC2e238Ed", // one-call launch
  padRouter:        "0xCA10a8821aF3D54eA9050A279EDd073654f5Fa1C", // every buy/sell
  rewardVault:      "0x5Ca5C1D2D10Bf605F9C42c5Baa0a3f897a3E3811", // 0.25% reward legs
  floorCoopFactory: "0x2615120ECbe93D5DC5e9268337f42817a3224102", // per-coin LP vaults
  platformSplitter: "0xF56A82476114BDadC425b850d53FEFCb847e7C65",
  weth:             "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  uniswapV3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
};

// Explorer link helper.
export const explorerUrl = (addr) => `${CHAIN.explorer}/address/${addr}`;

// Human-readable ABIs — ethers v6 parses these directly. Read + core write fns.
export const ABI = {
  factory: [
    "function launch((string name,string symbol,address dev,(uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,address projectWallet) tax) p) payable returns (address token,address curve,address pool)",
    "function tokenCount() view returns (uint256)",
    "function allTokens(uint256 index) view returns (address)",
    "function recordOf(address token) view returns (address token,address curve,address dev,uint256 at)",
    "event Launched(address indexed token,address indexed curve,address indexed pool,address dev,uint256 devBought)",
  ],
  router: [
    "function buy(address token,uint256 minOut) payable returns (uint256 tokensOut)",
    "function sell(address token,uint256 amountIn,uint256 minOutEth) returns (uint256 ethOut)",
    "function configOf(address token) view returns ((address pool,address curve,address projectWallet,uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,bool set))",
    "function devEscrow(address token) view returns (uint256)",
    "function bondOf(address token) view returns (address)",
    "event Bought(address indexed token,address indexed buyer,uint256 ethIn,uint256 fee,uint256 tokensOut)",
    "event Sold(address indexed token,address indexed seller,uint256 tokensIn,uint256 fee,uint256 ethOut)",
  ],
  floorCoopFactory: [
    "function coopOf(address token) view returns (address)", // 0x0 if none yet
  ],
  erc20: [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ],
};

// ── Indexer API client — the primary way to import feed data at scale ─────────
// Point it at your indexer host (see docs/api.md). Read-only; responses are cacheable.
export class RobinLabsAPI {
  constructor(base) {
    this.base = String(base || "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(this.base)) throw new Error("RobinLabsAPI needs an http(s) indexer base URL");
  }
  async _get(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return r.json();
  }
  health() { return this._get("/health"); }
  stats() { return this._get("/api/stats"); }
  /** opts: { sort:'new'|'trending'|'top'|'graduated', filter:'all'|'live'|'graduated', q, limit, cursor } */
  coins(opts = {}) {
    const q = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null)).toString();
    return this._get("/api/coins" + (q ? `?${q}` : ""));
  }
  coin(token) { return this._get(`/api/coin/${token}`); }
  trades(token) { return this._get(`/api/trades/${token}`); }
  /** A wallet's holdings (coins it launched or holds) — curve-derived, `approx:true`; refine with a live balanceOf. */
  holdings(addr) { return this._get(`/api/holdings/${addr}`); }
  /** A coin's holders: { token, approx, holders, top:[{holder,balance}] }. */
  holders(token, limit = 20) { return this._get(`/api/coin/${token}/holders?limit=${limit}`); }
  /** A coin's creator-set profile: { description, telegram, twitter, website, image, banner, updatedTs } or null. */
  profile(token) { return this._get(`/api/coin/${token}/meta`).then((r) => r.profile || null); }
  /** A wallet's claimable (with Merkle proofs) + pending rewards. */
  rewards(addr) { return this._get(`/api/rewards/${addr}`); }
  rewardsStats() { return this._get("/api/rewards/stats"); }
}

// ── On-chain read client — works with no indexer; pass ethers v6 + a provider ──
export class RobinLabsChain {
  constructor({ ethers, provider }) {
    if (!ethers || !provider) throw new Error("RobinLabsChain needs { ethers, provider } (ethers v6)");
    this._ethers = ethers;
    this._provider = provider;
    this.factory = new ethers.Contract(ADDRESSES.curvePadFactory, ABI.factory, provider);
    this.router = new ethers.Contract(ADDRESSES.padRouter, ABI.router, provider);
    this.floorCoopFactory = new ethers.Contract(ADDRESSES.floorCoopFactory, ABI.floorCoopFactory, provider);
  }
  // Discovery
  tokenCount() { return this.factory.tokenCount(); }
  tokenAt(i) { return this.factory.allTokens(i); }
  record(token) { return this.factory.recordOf(token); }
  // Per-coin reads
  config(token) { return this.router.configOf(token); }       // fee bps, pool, curve, projectWallet
  devEscrow(token) { return this.router.devEscrow(token); }   // creator's uncollected sell fees (wei)
  bond(token) { return this.router.bondOf(token); }           // 0x0 until graduated
  coop(token) { return this.floorCoopFactory.coopOf(token); } // per-coin FloorCoop LP vault (0x0 if none)
  token(token) { return new this._ethers.Contract(token, ABI.erc20, this._provider); }
  /** Watch new launches: cb(token, curve, pool, dev, devBought). Returns an unsubscribe fn. */
  onLaunch(cb) {
    const h = (token, curve, pool, dev, devBought) => cb({ token, curve, pool, dev, devBought });
    this.factory.on("Launched", h);
    return () => this.factory.off("Launched", h);
  }
}

export default { CHAIN, ADDRESSES, ABI, explorerUrl, RobinLabsAPI, RobinLabsChain };
