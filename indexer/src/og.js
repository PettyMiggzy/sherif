// ── Social share cards (Open Graph / Twitter) ────────────────────────────────
// Social crawlers (Twitterbot, TelegramBot, Discord, Slack) do NOT run JavaScript,
// so they only ever see the STATIC og:/twitter: tags in a page's raw HTML. The pad's
// token.html is a static file with one fixed og:image, which is why every shared coin
// used to unfurl as the same generic card. This module fixes that: the indexer renders
//   - GET /og/:token.png  → a per-coin share card image (coin pfp + name + live stats)
//   - GET /coin/:token    → a tiny HTML doc carrying that coin's real og:/twitter: tags,
//                            then bouncing a human visitor on to the pad's coin page.
// Share buttons point at /coin/:token so a shared link finally looks like a product.
import { CFG } from "./config.js";

// Lazily load sharp so the API still boots if the native addon is missing on a host.
let _sharp = null;
async function sharp() {
  if (_sharp) return _sharp;
  _sharp = (await import("sharp")).default;
  return _sharp;
}

const CARD_W = 1200, CARD_H = 630;

// XML/HTML-escape any coin-controlled string before it lands in SVG or a meta tag.
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Fit a long name onto the card without overflowing the art.
const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// Compact ETH figure: 2dp at scale, more precision for the tiny numbers memecoins live at.
function fmtEth(x) {
  const n = Number(x);
  if (!isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(4);
  return n.toPrecision(2);
}

// The card art as an SVG string. Text uses DejaVu (installed in the container via the
// Dockerfile) with a generic sans fallback; if a host lacks fonts the coin pfp + brand
// blocks still render, so the card degrades instead of breaking.
function cardSvg(coin) {
  const name = esc(clip(coin.name || "Untitled coin", 18));
  const sym = "$" + esc(clip(String(coin.symbol || "").replace(/^\$+/, "").toUpperCase(), 12));
  const graduated = !!coin.graduated;
  const progPct = Math.max(0, Math.min(100, Math.round((Number(coin.progress) || 0) * 100)));
  const mcap = fmtEth(coin.mcapEth);
  const vol = fmtEth(coin.vol24hEth != null ? coin.vol24hEth : coin.volAllEth);
  const trades = Number(coin.trades24h != null ? coin.trades24h : coin.tradesAll) || 0;

  // status ribbon: graduated pill or a live bonding progress bar
  const statusBlock = graduated
    ? `<g transform="translate(96,486)">
         <rect width="260" height="52" rx="26" fill="#12210a" stroke="#8fe64a" stroke-width="2"/>
         <text x="130" y="34" font-family="DejaVu Sans, sans-serif" font-size="24" font-weight="700" fill="#bff58a" text-anchor="middle" letter-spacing="1">GRADUATED</text>
       </g>`
    : `<g transform="translate(96,492)">
         <text x="0" y="0" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="700" fill="#9aa08a">BONDING</text>
         <text x="612" y="0" font-family="DejaVu Sans Mono, monospace" font-size="22" font-weight="700" fill="#dce905" text-anchor="end">${progPct}%</text>
         <rect x="0" y="14" width="612" height="16" rx="8" fill="#20261a"/>
         <rect x="0" y="14" width="${Math.max(16, Math.round(612 * progPct / 100))}" height="16" rx="8" fill="#dce905"/>
       </g>`;

  const stat = (x, label, value) => `
    <g transform="translate(${x},372)">
      <text x="0" y="0" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="700" fill="#7f846f" letter-spacing="1">${label}</text>
      <text x="0" y="40" font-family="DejaVu Sans Mono, monospace" font-size="34" font-weight="700" fill="#f4f7ea">${value}</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <radialGradient id="bg" cx="82%" cy="18%" r="90%">
      <stop offset="0" stop-color="#18220c"/><stop offset="1" stop-color="#0b0e07"/>
    </radialGradient>
    <linearGradient id="mark" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#aeb800"/><stop offset="1" stop-color="#dce905"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${CARD_W}" height="8" fill="#dce905"/>

  <!-- brand -->
  <g transform="translate(96,84)">
    <rect x="0" y="-30" width="44" height="44" rx="11" fill="url(#mark)"/>
    <text x="22" y="3" font-family="DejaVu Sans, sans-serif" font-size="30" font-weight="800" fill="#0b0e07" text-anchor="middle">R</text>
    <text x="62" y="4" font-family="DejaVu Sans, sans-serif" font-size="27" font-weight="800" fill="#f4f7ea" letter-spacing="2">ROBIN <tspan fill="#dce905">LABS</tspan></text>
  </g>

  <!-- identity -->
  <text x="96" y="232" font-family="DejaVu Sans, sans-serif" font-size="72" font-weight="800" fill="#ffffff">${name}</text>
  <text x="96" y="296" font-family="DejaVu Sans Mono, monospace" font-size="40" font-weight="700" fill="#dce905">${sym}</text>

  ${stat(96, "MARKET CAP", mcap + " ETH")}
  ${stat(392, "24H VOLUME", vol + " ETH")}
  ${stat(688, "24H TRADES", trades.toLocaleString("en-US"))}

  ${statusBlock}

  <text x="${CARD_W - 96}" y="590" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="700" fill="#7f846f" text-anchor="end">Fair launch on Robinhood Chain</text>
</svg>`;
}

// Rounded-square mask so a composited pfp gets the same soft corners as the pad UI.
function maskSvg(size, r) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`
  );
}

// Render the full PNG card. `pfp` is an optional { blob, mime } for the coin image; when
// present it's rounded and composited into the art's right side. Any failure on the pfp
// leg still yields the text card, and a total failure throws to the caller's fallback.
export async function renderCard(coin, pfp) {
  const S = await sharp();
  const base = S(Buffer.from(cardSvg(coin))).png();

  const composites = [];
  if (pfp && pfp.blob && pfp.blob.length) {
    try {
      const D = 200, R = 32, X = CARD_W - 96 - D, Y = 64;
      const rounded = await S(pfp.blob)
        .resize(D, D, { fit: "cover" })
        .composite([{ input: maskSvg(D, R), blend: "dest-in" }])
        .png()
        .toBuffer();
      // a lime frame behind the pfp so it reads as a card element, not a floating cutout
      const frame = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${D + 12}" height="${D + 12}"><rect width="${D + 12}" height="${D + 12}" rx="${R + 6}" fill="none" stroke="#dce905" stroke-width="4"/></svg>`
      );
      composites.push({ input: frame, top: Y - 6, left: X - 6 });
      composites.push({ input: rounded, top: Y, left: X });
    } catch { /* text card without the pfp is fine */ }
  }
  if (composites.length) base.composite(composites);
  return base.png().toBuffer();
}

// The tiny HTML doc a crawler reads for the real per-coin unfurl tags, and that bounces a
// human to the pad's coin page. `imageUrl` is the absolute /og/:token.png URL; `siteBase`
// is the pad origin the human lands on.
export function coinOgHtml(coin, imageUrl, siteBase) {
  // Keep everything RAW here and escape exactly once at the point of insertion below —
  // pre-escaping and re-escaping would double-encode a name like "Tom & Jerry".
  const token = coin.token;
  const nm = clip(coin.name || "Coin", 40);
  const sym = String(coin.symbol || "").replace(/^\$+/, "").toUpperCase();
  const title = `${nm} ($${sym}) on Robin Labs`;
  const desc = coin.graduated
    ? `${nm} graduated on Robin Labs, the fair-launch pad on Robinhood Chain. Live chart, holders and trades.`
    : `Trade ${nm} on Robin Labs, the fair-launch pad on Robinhood Chain. Live price, chart and holders.`;
  const dest = `${siteBase.replace(/\/+$/, "")}/token.html?c=${token}`;
  const img = esc(imageUrl);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="Robin Labs"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:url" content="${esc(dest)}"/>
<meta property="og:image" content="${img}"/>
<meta property="og:image:width" content="${CARD_W}"/>
<meta property="og:image:height" content="${CARD_H}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:site" content="@robinlabzz"/>
<meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(desc)}"/>
<meta name="twitter:image" content="${img}"/>
<link rel="canonical" href="${esc(dest)}"/>
<meta http-equiv="refresh" content="0; url=${esc(dest)}"/>
<script>location.replace(${JSON.stringify(dest)});</script>
</head><body style="background:#0b0e07;color:#f4f7ea;font-family:system-ui,sans-serif;text-align:center;padding:64px 20px">
<p>Opening ${esc(nm)} on Robin Labs…</p>
<p><a href="${esc(dest)}" style="color:#dce905">Continue to the coin page</a></p>
</body></html>`;
}

export const OG = { CARD_W, CARD_H };
