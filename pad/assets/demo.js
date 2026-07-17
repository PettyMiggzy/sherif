// ─────────────────────────────────────────────────────────────────────────────
// Demo data — loads ONLY when the URL has ?demo=1 (or #demo). Lets you preview a
// fully-populated pad before any real coins launch. It never touches the live
// feed otherwise, so real visitors still see the honest (empty) board.
//   Preview:  robinlabs.io/?demo=1   ·   robinlabs.io/token.html?c=<any>&demo=1
// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY: demo is ON by default so the populated pad is visible for review.
// Add ?live=1 to see the real (empty) board. Flip this back to opt-in
// (has("demo")) before launching real coins — otherwise real coin pages render
// the sample coin instead of the live one.
export const DEMO = typeof location !== "undefined" &&
  !new URLSearchParams(location.search).has("live");

// Floating "PREVIEW" badge so sample data is never mistaken for real numbers.
if (DEMO && typeof document !== "undefined") {
  const mount = () => {
    if (document.getElementById("demo-banner")) return;
    const el = document.createElement("div");
    el.id = "demo-banner";
    el.style.cssText = "position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:9998;background:#dce905;color:#0a0e05;font-family:system-ui,-apple-system,sans-serif;font-weight:800;font-size:.78rem;letter-spacing:.02em;padding:8px 16px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.45);white-space:nowrap";
    el.textContent = "👁 PREVIEW — sample coins, not live data";
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

export const DEMO_COINS = SEED.map((c, i) => ({
  token: hex(i + 3), curve: hex(i + 70), pool: hex(i + 130), dev: hex(i + 200),
  name: c[0], symbol: c[1], mc: c[2], prog: c[3], state: c[4],
  image: "assets/coins/" + c[1].toLowerCase() + ".png",
  vol: Math.round(c[2] * (0.18 + (i % 5) * 0.16)),
  holders: Math.max(80, Math.round(c[2] / (28 + (i % 7) * 6))),
  at: Math.floor((typeof Date !== "undefined" ? Date.now() : 0) / 1000) - (i + 1) * 2600 * (1 + (i % 6)),
  i,
}));

// Headline stats for the landing page (demo values; the live pad computes real).
export const DEMO_STATS = {
  coins: 47, graduated: 12, volAllEth: 210.4, vol24hEth: 38.7,
  projectsLaunched: 1248, graduatedTotal: 312, rewardsPaidEth: 158,
  mcapCreatedUsd: 84e6, totalVolumeUsd: 212e6,
};

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
