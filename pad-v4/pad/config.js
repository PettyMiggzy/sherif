// ─────────────────────────────────────────────────────────────────────────────
// Robin V4 "curve-on-V4" launchpad — UI config
//
// DEPLOY FILLS THESE. Every address below is a placeholder ('' = unset). The UI is
// mock-first: whenever an address is unset (or ethers/wallet is unavailable) the
// dashboard and profile fall back to the DEMO dataset so the page always renders
// something meaningful and never shows a broken/blank state.
//
// After `npx hardhat run scripts/deploy.js` + per-coin `launch.js`, paste the
// emitted addresses into ADDR and COINS below (or generate this file from
// deploy.local.json, the same way staging/config.js is generated).
// ─────────────────────────────────────────────────────────────────────────────

// Robinhood Chain — the native home of the V4 pad suite. Native quote = address(0).
export const CHAIN = {
  id: 4663,
  hexId: '0x1237',
  name: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  nativeSymbol: 'ETH',
};

// Platform-level singletons (deployed once by scripts/deploy.js). DEPLOY FILLS.
export const ADDR = {
  poolManager: '',   // 0x8366a39CC670B4001A1121B8F6A443A643e40951 (live V4 PoolManager)
  stateView: '',     // RobinStateView — extsload lens bound to our PoolManager
  feeConfig: '',     // RobinV4FeeConfig — governed launch defaults
  curveFactory: '',  // CurvePadFactoryV4 — free single-sided launches
  lockVault: '',     // LockVault — holds the permanent graduation LP forever
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', // canonical, chain-agnostic
};

// Per-coin address book, keyed by the pad TOKEN address (lower-cased).
// Each launch emits: token, hook, curve, staking, floor, ambush (+ optional presale).
// DEPLOY FILLS. Unset entries transparently render from DEMO.
export const COINS = {
  // '0xabc…': { curve:'', staking:'', hook:'', floor:'', ambush:'', presale:'' },
};

// Graduation geometry / economic constants (from the LOCKED curve spec).
export const GRAD = {
  targetEth: 4.2,        // raise at the ceiling (~4.2 ETH)
  targetMcUsd: 34000,    // market cap at graduation (~$34k)
  gradRewardEth: 0.5,    // platform 0.5 + creator 0.5 at graduation (capped raise/4)
  lpFeeBps: 100,         // 1% pool LP fee
  tradeTaxBps: 100,      // 1% directional hook tax
  buyLpFloorShareBps: 0, // 100% of buy LP fee → platform (live default; set >0 only to re-fund floor from the buy-LP leg)
  ethUsd: 2450,          // display FX; wire to an oracle/feed at deploy
};

// ─────────────────────────────────────────────────────────────────────────────
// DEMO dataset — the single source of truth for mock rendering.
// Numbers are self-consistent: a coin ~68% of the way up its curve.
// Replace with live reads once COINS[...] addresses are set.
// ─────────────────────────────────────────────────────────────────────────────
export const DEMO = {
  token: '0x7011AbcadeCafe0000000000000000000TR0LLcat',
  name: 'Troll Cat',
  symbol: 'TROLL',
  decimals: 18,
  creator: '0x9a7DdCB3b2Fe10c6c5C3d3E7a2b1F0e9D8c7B6A5',

  // curve ticks: buys walk the tick DOWN from startTick (launch) toward gradTick (ceiling).
  startTick: -138000,   // launch price (curve top; pure-token boundary)
  gradTick: -170000,    // ceiling (lower); buys stop here → graduate()
  currentTick: -159760, // ≈ 68% of the way to the ceiling
  seeded: true,
  graduated: false,

  // headline figures (display units; wire to live reads at deploy)
  priceUsd: 0.00002158,
  price24hChangePct: 12.4,
  totalSupply: 1_000_000_000,   // full mint
  curveSupply: 800_000_000,     // sellable on the curve (rest = ambush reserve + LP)
  tokensSold: 545_600_000,      // walked out of the range so far
  raisedEth: 2.856,             // of GRAD.targetEth
  holders: 214,
  volume24hUsd: 18_420,

  // staking pool snapshot — mirrors RobinLockStaking.poolInfo()
  staking: {
    totalStaked: 132_400_000,   // principal
    rewardsBalance: 24_180_000, // pool amount (reservoir + owed)
    reservoir: 18_050_000,      // undripped
    aprBps: 4230,               // 42.30%
    ratePerSec: 6.97,           // tokens/sec dripping
    finishInDays: 20,           // periodFinish − now
    lockDays: 30,
    earlyExitPenaltyBps: 1000,  // 10%
    // connected-user position (mirrors stakeInfo(addr))
    user: { staked: 4_200_000, claimable: 86_400, unlockInDays: 18, locked: true },
  },

  // trust-signal mini-cards
  floorEth: 0.42,      // permanent, add-only ETH buy-wall
  ambushArmed: true,   // two-sided support band live from launch
  ambushBandEth: 0.31, // ETH the ambush wall has already routed to the floor
};

// A deterministic 90-point price series (USD) for the mock chart — trends up with
// texture, ending at DEMO.priceUsd. Generated so the page is stable across reloads.
export function demoSeries(points = 90, endPrice = DEMO.priceUsd) {
  const out = [];
  let seed = 1337;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const start = endPrice * 0.34;
  let v = start;
  const drift = Math.pow(endPrice / start, 1 / (points - 1));
  for (let i = 0; i < points; i++) {
    const noise = 1 + (rnd() - 0.46) * 0.09;
    v = v * drift * noise;
    out.push(Math.max(v, start * 0.6));
  }
  // pin the final point exactly to the headline price
  out[out.length - 1] = endPrice;
  return out;
}

// DEMO holdings/positions for the profile page (used when no live reads available).
export const DEMO_PROFILE = {
  address: '0x9a7DdCB3b2Fe10c6c5C3d3E7a2b1F0e9D8c7B6A5',
  holdings: [
    { symbol: 'TROLL', name: 'Troll Cat',   balance: 4_200_000, priceUsd: 0.00002158, changePct: 12.4 },
    { symbol: 'GIGA',  name: 'Gigachad',     balance: 1_180_000, priceUsd: 0.00005400, changePct: -4.1 },
    { symbol: 'WOJAK', name: 'Wojak Finance', balance: 22_400_000, priceUsd: 0.00000091, changePct: 61.7 },
    { symbol: 'BONKR', name: 'Bonker',       balance: 640_000,   priceUsd: 0.00013800, changePct: 3.2 },
  ],
  staking: [
    { symbol: 'TROLL', staked: 4_200_000, priceUsd: 0.00002158, claimable: 86_400, unlockInDays: 18, locked: true, penaltyBps: 1000 },
    { symbol: 'GIGA',  staked: 900_000,   priceUsd: 0.00005400, claimable: 12_100, unlockInDays: 0,  locked: false, penaltyBps: 1000 },
  ],
  launched: [
    { symbol: 'TROLL', name: 'Troll Cat', raisedEth: 2.856, targetEth: 4.2, graduated: false, holders: 214 },
    { symbol: 'PURRP', name: 'Purr Protocol', raisedEth: 4.2, targetEth: 4.2, graduated: true, holders: 902 },
  ],
  presales: [
    { symbol: 'MOONR', name: 'Moon Reserve', contributedEth: 0.35, raisedEth: 3.1, targetEth: 5.0, state: 0, deadlineInDays: 2 }, // Open
    { symbol: 'RUGME', name: 'Rug Me Not',   contributedEth: 0.20, raisedEth: 1.2, targetEth: 6.0, state: 2, deadlineInDays: 0 }, // Failed → refund
  ],
  // referral earnings — a slice of the platform's buy tax on buys that came through your ref link (paid in the
  // coin, per coin you referred). Mirrors hook.referralOwed(you, token); claim with hook.claimReferral(token).
  referrals: [
    { symbol: 'TROLL', name: 'Troll Cat',      earned: 1_240_000, priceUsd: 0.00002158, buys: 86 },
    { symbol: 'PURRP', name: 'Purr Protocol',  earned: 402_000,   priceUsd: 0.00009100, buys: 41 },
    { symbol: 'GIGA',  name: 'Gigachad',       earned: 95_000,    priceUsd: 0.00005400, buys: 12 },
  ],
};
