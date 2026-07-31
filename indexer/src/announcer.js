// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — launch announcer.
//
// Watches the pad for NEW coins and posts each one to a Telegram channel automatically, so every launch
// turns into free content. Reads the public indexer API (no chain access, no wallet, no keys beyond the
// Telegram bot token), and remembers what it already posted so a restart never double-announces.
//
// OFF unless TG_BOT_TOKEN and TG_CHAT are set. Run:  node src/announcer.js
//   TG_BOT_TOKEN  the @BotFather bot token (SECRET, .env only)
//   TG_CHAT       the channel to post to: "@robinlabslaunches" or a numeric chat id (add the bot as admin)
// Optional:
//   ANNOUNCE_API_BASE     default https://api.robinlab.io   (where /api/coins lives)
//   ANNOUNCE_SITE_BASE    default https://robinlab.io       (coin links point here, the fresh site)
//   ANNOUNCE_BANNER_URL   a public image URL (the promo graphic). When set, every launch post LEADS with
//                         this banner on top, and the coin's own image rides second in the same album.
//   ANNOUNCE_POLL_MS      default 30000
//   ANNOUNCE_BACKLOG      "1" to also post coins that already exist on first run (default: seed silently)
//   ANNOUNCE_STATE        state file path (default ./data/announced.json)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TOKEN = (process.env.TG_BOT_TOKEN || "").trim();
const CHAT = (process.env.TG_CHAT || "").trim();
const API = (process.env.ANNOUNCE_API_BASE || "https://api.robinlab.io").replace(/\/+$/, "");
const SITE = (process.env.ANNOUNCE_SITE_BASE || "https://robinlab.io").replace(/\/+$/, "");
const BANNER = (process.env.ANNOUNCE_BANNER_URL || "").trim();  // promo graphic posted on top of every launch
const TG_API = (process.env.TG_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""); // override for tests
const POLL_MS = Number(process.env.ANNOUNCE_POLL_MS || 30000);
const STATE = process.env.ANNOUNCE_STATE || "./data/announced.json";
const BACKLOG = process.env.ANNOUNCE_BACKLOG === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Persisted set of already-announced token addresses (survives restarts).
function loadSeen() {
  try { return new Set(JSON.parse(readFileSync(STATE, "utf8")).seen || []); } catch { return null; }
}
function saveSeen(seen) {
  try { mkdirSync(dirname(STATE), { recursive: true }); } catch {}
  try { writeFileSync(STATE, JSON.stringify({ seen: [...seen], updated: Math.floor(Date.now() / 1000) })); } catch (e) { console.log("[announcer] state write failed:", e.message); }
}

async function getJson(url) {
  try { const r = await fetch(url, { headers: { accept: "application/json" } }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

// Telegram Bot API call. Returns the parsed body or null.
async function tg(method, params) {
  try {
    const r = await fetch(`${TG_API}/bot${TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    });
    const j = await r.json();
    if (!j.ok) console.log(`[announcer] telegram ${method} error:`, j.description || JSON.stringify(j));
    return j.ok ? j : null;
  } catch (e) { console.log(`[announcer] telegram ${method} threw:`, e.message); return null; }
}

const fmtUsd = (n) => (n == null ? null : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const esc = (s) => String(s ?? "").replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c])); // HTML parse_mode

// Build the announcement text for a coin (brand voice: no em-dashes, no emoji-spam, only true mechanics).
export function caption(c) {
  const sym = String(c.symbol || "").replace(/^\$+/, "");
  const link = `${SITE}/token.html?c=${c.token}`;
  const mc = fmtUsd(c.mcapUsd) || (c.mcapEth != null ? `${Number(c.mcapEth).toFixed(3)} ETH` : null);
  const lines = [
    `<b>${esc(c.name || "New coin")}</b> just launched on Robinhood Chain`,
    ``,
    `$${esc(sym)}`,
    `<code>${esc(c.token)}</code>`,
  ];
  if (mc) lines.push(`Market cap: ${esc(mc)}`);
  lines.push(``, `Fair launch into real Uniswap v3 liquidity with a permanent floor.`, ``, `Trade: ${link}`);
  return lines.join("\n");
}

export async function announce(c) {
  const text = caption(c);
  // The coin's own image (creator pfp) makes a richer card; a public URL is required for Telegram to fetch it.
  const coinImg = c.image || (c.has_pfp ? `${API}/media/${c.token}/pfp` : null);
  const base = { chat_id: CHAT, parse_mode: "HTML", disable_web_page_preview: false };
  let ok = false;

  // With a promo BANNER set, every launch LEADS with it. If the coin also has an image, post an album
  // (banner first, coin image second) with the launch details as the caption on the banner; otherwise
  // just the banner captioned. Telegram renders album captions under the first photo, so the brand
  // graphic sits on top of the text exactly as intended.
  if (BANNER) {
    if (coinImg) {
      ok = !!(await tg("sendMediaGroup", {
        chat_id: CHAT,
        media: [
          { type: "photo", media: BANNER, caption: text, parse_mode: "HTML" },
          { type: "photo", media: coinImg },
        ],
      }));
    }
    if (!ok) ok = !!(await tg("sendPhoto", { ...base, photo: BANNER, caption: text }));
  } else if (coinImg) {
    ok = !!(await tg("sendPhoto", { ...base, photo: coinImg, caption: text }));
  }
  if (!ok) ok = !!(await tg("sendMessage", { ...base, text }));
  if (ok) console.log(`[announcer] posted ${c.symbol} (${c.token.slice(0, 10)})`);
  return ok;
}

async function tick(seen) {
  // Newest first; a small page is plenty at any realistic launch cadence.
  const j = await getJson(`${API}/api/coins?sort=new&limit=25`);
  const coins = (j && j.coins) || [];
  if (!coins.length) return;
  // Oldest-first so multiple new coins post in chronological order.
  const fresh = coins.filter((c) => c && c.token && !seen.has(c.token.toLowerCase())).reverse();
  for (const c of fresh) {
    const ok = await announce(c);
    seen.add(c.token.toLowerCase());
    if (ok) saveSeen(seen);        // persist as we go so a crash never re-announces
    await sleep(1200);             // gentle pace, well under Telegram's limits
  }
}

async function main() {
  if (!TOKEN || !CHAT) { console.log("[announcer] disabled (set TG_BOT_TOKEN and TG_CHAT to run)"); setInterval(() => {}, 1 << 30); return; }
  let seen = loadSeen();
  if (seen === null) {
    // First run: unless ANNOUNCE_BACKLOG=1, seed with whatever exists now so we don't spam the whole history.
    seen = new Set();
    if (!BACKLOG) {
      const j = await getJson(`${API}/api/coins?sort=new&limit=200`);
      for (const c of ((j && j.coins) || [])) if (c && c.token) seen.add(c.token.toLowerCase());
      console.log(`[announcer] first run: seeded ${seen.size} existing coins (will only post NEW launches). Set ANNOUNCE_BACKLOG=1 to post the backlog.`);
    }
    saveSeen(seen);
  }
  console.log(`[announcer] running -> ${CHAT}, polling ${API}/api/coins every ${POLL_MS}ms`);
  for (;;) {
    try { await tick(seen); } catch (e) { console.log("[announcer] tick error:", e.message); }
    await sleep(POLL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
