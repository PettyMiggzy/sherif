// The exact events the live contracts emit (see contracts/*.sol). We only need
// the four that drive the pad: a coin launching, a buy, a sell, a graduation.
import { ethers } from "ethers";

export const EVENTS = [
  // CurvePadFactory
  "event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)",
  // PadRouter
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut)",
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut)",
  // CurvePool (emitted by each curve; matched back to its token by address)
  "event Graduated(address indexed bond, uint256 raisedWeth, uint256 leftoverToken)",
  // RewardVault — one per trade's 0.25% leg (side: 0=Traders buy leg, 1=Holders sell leg)
  "event Accrued(address indexed coin, uint256 indexed epoch, uint8 side, uint256 amount)",
  // Uniswap v3 pool — the COMPLETE trade feed. We index these (not just our router's
  // Bought/Sold) because bots, DexScreener and aggregators swap the pool DIRECTLY,
  // bypassing our router — so router events see only a sliver of the real volume, and
  // the pool's own price/tick never refreshes. One Swap == one executed trade.
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];

// Minimal read ABIs for enriching a coin at launch time (name / symbol).
export const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

// Curve geometry (read once at launch) — the ticks that define the bonding curve's
// start and ceiling. Graduation is ceiling-only; minGradTick/gradTarget are read as
// vestigial fields (kept on-chain) purely to fill the legacy DB columns.
export const CURVE = [
  "function startTick() view returns (int24)",
  "function minGradTick() view returns (int24)",
  "function gradTick() view returns (int24)",
  "function gradTarget() view returns (int24)",
  "function pool() view returns (address)",
];

// Pool slot0 (current sqrtPrice/tick) + token0 for price orientation.
export const POOL = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIdx, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
];

export const iface = new ethers.Interface(EVENTS);

// topic0 for each event, so we can filter getLogs cheaply.
export const TOPICS = {
  Launched: iface.getEvent("Launched").topicHash,
  Bought: iface.getEvent("Bought").topicHash,
  Sold: iface.getEvent("Sold").topicHash,
  Graduated: iface.getEvent("Graduated").topicHash,
  Accrued: iface.getEvent("Accrued").topicHash,
  Swap: iface.getEvent("Swap").topicHash,
};
