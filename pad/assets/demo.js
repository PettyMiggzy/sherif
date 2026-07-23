// ─────────────────────────────────────────────────────────────────────────────
// Demo data — OPT-IN preview. Loads ONLY when the URL has ?demo=1; otherwise every
// visitor sees the honest, live on-chain board. The stack is deployed and coins have
// launched, so sample data is never the default — just a populated-pad preview.
//   Preview:  robinlabs.io/?demo=1   ·   robinlabs.io/token.html?c=<any>&demo=1
// (Was temporarily ON-by-default during pre-launch review — now flipped to opt-in.)
const _q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
export const DEMO = typeof location !== "undefined" && ["1","true",""].includes(_q.get("demo"));

// Floating "PREVIEW" badge so sample data is never mistaken for real numbers.
if (DEMO && typeof document !== "undefined") {
  const mount = () => {
    if (document.getElementById("demo-banner")) return;
    const el = document.createElement("div");
    el.id = "demo-banner";
    // corner pill + tap-through, so it never covers or blocks the CTA buttons
    el.style.cssText = "position:fixed;bottom:12px;right:12px;left:auto;z-index:9998;pointer-events:none;background:#dce905;color:#0a0e05;font-family:system-ui,-apple-system,sans-serif;font-weight:800;font-size:.72rem;letter-spacing:.02em;padding:7px 13px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.45);white-space:nowrap;opacity:.94";
    el.textContent = "👁 PREVIEW — sample data";
    document.body.appendChild(el);
  };
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);
}

// deterministic fake 0x-address (valid shape, obviously not real). An LCG keyed
// by the seed so different seeds never collide (a simple seed*k+i mod 16 would
// repeat every 16 seeds and duplicate the labelled protocol rows).
const hex = (seed) => {
  let x = ((seed + 1) * 2654435761) >>> 0, s = "";
  for (let i = 0; i < 40; i++) { x = (x * 1103515245 + 12345) >>> 0; s += "0123456789abcdef"[(x >>> 12) & 15]; }
  return "0x" + s;
};

// [name, symbol, marketCapUSD, progress%, state] — sample coins for the preview.
// Images are real, recognizable project logos (assets/coins/<symbol>.png, pulled
// once from CoinGecko) so the preview board looks varied and populated for demos.
// These are sample/PREVIEW data only — real coins carry the creator's own logo.
const SEED = [
  ["Dogecoin", "DOGE", 980000, 100, "done"],
  ["Shiba Inu", "SHIB", 412000, 100, "done"],
  ["Pepe", "PEPE", 205000, 100, "done"],
  ["Pump.fun", "PUMP", 128000, 100, "done"],
  ["Pudgy Penguins", "PENGU", 74000, 92, "grad"],
  ["SPX6900", "SPX", 51000, 72, "new"],
  ["Bonk", "BONK", 33000, 47, "new"],
  ["Peanut", "PEANUT", 22000, 33, "new"],
  ["FLOKI", "FLOKI", 17000, 26, "new"],
  ["Ape and Pepe", "APEPE", 12500, 19, "new"],
  ["coco", "COCO", 9500, 14, "new"],
  ["dogwifhat", "WIF", 6800, 100, "done"],
];

// 24h change per coin (deterministic) — gives the trending ticker green/red life.
const CHG = [128.4, 42.1, 18.7, 9.3, 64.2, -12.5, 27.8, -6.4, 33.1, 5.2, -9.8, 88.6];

export const DEMO_COINS = SEED.map((c, i) => ({
  token: hex(i + 3), curve: hex(i + 70), pool: hex(i + 130), dev: hex(i + 200),
  name: c[0], symbol: c[1], mc: c[2], prog: c[3], state: c[4],
  image: "assets/coins/" + c[1].toLowerCase() + ".png",
  vol: Math.round(c[2] * (0.18 + (i % 5) * 0.16)),
  holders: Math.max(80, Math.round(c[2] / (28 + (i % 7) * 6))),
  chg: CHG[i % CHG.length],
  at: Math.floor((typeof Date !== "undefined" ? Date.now() : 0) / 1000) - (i + 1) * 2600 * (1 + (i % 6)),
  i,
}));

// Headline stats for the landing page (demo values; the live pad computes real).
export const DEMO_STATS = {
  coins: 47, graduated: 12, volAllEth: 210.4, vol24hEth: 38.7,
  projectsLaunched: 1248, graduatedTotal: 312, rewardsPaidEth: 158,
  mcapCreatedUsd: 84e6, totalVolumeUsd: 212e6,
};

// Reward-engine demo data for the Rewards page. Models the additive fee legs: every trade pays an
// extra 0.25% to net-volume TRADERS and 0.25% to size×time HOLDERS of that coin, claimable as real ETH
// (users pay their own gas). These are sample values so the claim UI renders populated in preview.
export const DEMO_REWARDS = {
  epoch: 19_631, // current epoch index (1-day epochs)
  epochEndsIn: 4 * 3600 + 12 * 60, // seconds until this epoch closes
  claimWindowH: 48, // challenge window before an ended epoch's rewards open
  // protocol-wide, all-time
  totals: { paidEth: 158.0, tradersEth: 84.3, holdersEth: 73.7, floorGrownEth: 41.2, claimants: 3120 },
  // the connected wallet's CLAIMABLE rewards (past epochs, finalized) — one row per (coin, side, epoch)
  claimable: [
    { sym: "PENGU", name: "Pudgy Penguins", token: "", side: "Holders", epoch: 19_629, eth: 0.0412, reason: "held 74M for 22h" },
    { sym: "PENGU", name: "Pudgy Penguins", token: "", side: "Traders", epoch: 19_629, eth: 0.0231, reason: "net +74M bought" },
    { sym: "SPX", name: "SPX6900", token: "", side: "Traders", epoch: 19_630, eth: 0.0186, reason: "net +51M bought" },
    { sym: "BONK", name: "Bonk", token: "", side: "Holders", epoch: 19_630, eth: 0.0093, reason: "held 33M for 15h" },
    { sym: "WIF", name: "dogwifhat", token: "", side: "Holders", epoch: 19_628, eth: 0.0067, reason: "held 6.8M full epoch" },
  ],
  // the wallet's rewards ACCRUING this (not-yet-finalized) epoch — pending, not claimable until it ends
  pending: [
    { sym: "SPX", name: "SPX6900", side: "Traders", eth: 0.0074 },
    { sym: "BONK", name: "Bonk", side: "Holders", eth: 0.0031 },
  ],
};

// Community floor-vault (FloorCoop) demo data for the coin page. Users add ETH to a below-price buy-wall
// and earn the dip-buy fees; withdrawable after a cooldown; can't hurt the coin (it sits under the price).
export const DEMO_FLOOR = { tvlEth: 6.4, feesPaidEth: 1.82, mineEth: 0.25, earnedEth: 0.0074, backers: 38 };

// Floor pools for the Liquidity page — one per graduated coin. Deterministic sample data. `mineEth`>0 means
// the connected sample wallet already has a position in that pool.
export const DEMO_POOLS = SEED.filter((c) => c[4] === "done").map((c, i) => ({
  sym: c[1], name: c[0], image: "assets/coins/" + c[1].toLowerCase() + ".png",
  tvlEth: +(2 + (c[2] / 1e6) * 6 + (i % 4) * 1.3).toFixed(2),
  feesPaidEth: +(0.4 + (c[2] / 1e6) * 1.7 + (i % 3) * 0.25).toFixed(3),
  backers: 12 + ((i * 7) % 40),
  aprPct: +(9 + (i * 13) % 22).toFixed(1),          // realized-fee APR estimate (sample)
  mineEth: i === 0 ? 0.25 : (i === 2 ? 0.1 : 0),     // sample wallet backs a couple pools
  earnedEth: i === 0 ? 0.0074 : (i === 2 ? 0.0031 : 0),
}));

// Daily analytics series for the stats page (demo values). Deterministic — a
// gentle upward trend with a mid-window viral spike, so the preview charts look
// like a launchpad finding traction. The live pad draws the real series.
export function demoSeries(days = 30) {
  const now = Math.floor((typeof Date !== "undefined" ? Date.now() : 0) / 1000);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = days - i;                     // 1..days, oldest→newest
    const ramp = day / days;                  // 0→1 growth
    const wobble = 0.6 + 0.4 * Math.abs(Math.sin(day * 1.3));
    const spike = Math.abs(day - Math.round(days * 0.62)) < 2 ? 3.1 : 1; // a viral day
    const volEth = +(2.2 + 34 * ramp * ramp * wobble * spike).toFixed(2);
    const trades = Math.round(18 + 190 * ramp * wobble * spike);
    const t = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10);
    out.push({
      d: t, volEth, trades,
      buys: Math.round(trades * 0.57), sells: trades - Math.round(trades * 0.57),
      launched: Math.round(1 + 9 * ramp * wobble * spike),
      graduated: (day % 3 === 0 || spike > 1) ? Math.round(1 + 2 * ramp * spike) : 0,
    });
  }
  return out;
}

// A recent buy/sell tape for the coin page.
export function demoTrades(n = 18) {
  const now = Math.floor((typeof Date !== "undefined" ? Date.now() : 0) / 1000);
  const out = [];
  for (let i = 0; i < n; i++) {
    const buy = (i * 5 + 2) % 3 !== 0;
    out.push({
      side: buy ? "buy" : "sell",
      actor: hex(i + 500),
      eth: String(Math.round((0.02 + (i % 7) * 0.035) * 1e18)),
      tokens: String(Math.round((50000 + i * i * 3100) * 1e18)),
      tx: hex(i + 300), ts: now - i * 47 - (i % 4) * 90,
    });
  }
  return out;
}

// Top holders — the protocol addresses use the coin's real curve/pool/dev so the
// coin page's existing label logic tags them (🏹 curve, 🦄 pool, 👑 creator).
export function demoHolders(coin) {
  const top = [
    { address: coin.curve, isContract: true, name: null, pct: 62.4 },
    { address: coin.pool, isContract: true, name: null, pct: 11.8 },
    { address: coin.dev, isContract: false, name: null, pct: 1.9 },
  ];
  for (let i = 0; i < 8; i++) top.push({ address: hex(i + 400), isContract: false, name: null, pct: +(6.2 / (i + 1.5)).toFixed(2) });
  return { count: 214, top };
}
