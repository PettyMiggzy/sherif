// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — launch + graduation announcer.
//
// Watches the pad and posts to a Telegram channel automatically, so every launch AND every graduation
// turns into free content. Reads the public indexer API (no chain access, no wallet, no keys beyond the
// Telegram bot token), and remembers what it already posted so a restart never double-announces.
//
// OFF unless TG_BOT_TOKEN and TG_CHAT are set. Run:  node src/announcer.js
//   TG_BOT_TOKEN  the @BotFather bot token (SECRET, .env only)
//   TG_CHAT       the channel to post to. MUST be a "@publicusername" (no spaces) or a numeric chat id
//                 like -1001234567890 (NOT a display name). Add the bot to the channel as an ADMIN.
// Optional:
//   ANNOUNCE_API_BASE      default https://api.robinlab.io   (where /api/coins lives)
//   ANNOUNCE_SITE_BASE     default https://robinlab.io       (coin links point here, the fresh site)
//   ANNOUNCE_BANNER_URL    a public image URL (the promo graphic). When set, every post LEADS with this
//                          banner on top, and the coin's own image rides second in the same album.
//   ANNOUNCE_GRADUATIONS   "0" to only post launches (default: post launches AND graduations)
//   ANNOUNCE_POLL_MS       default 30000
//   ANNOUNCE_BACKLOG       "1" to also post coins that already exist on first run (default: seed silently)
//   ANNOUNCE_STATE         state file path (default ./data/announced.json)
//
// Manual smoke test (posts ONE coin to the channel right now, so you can confirm it works without a real
// launch, and without touching the "already announced" state):
//   node src/announcer.js --test                 # posts the newest coin
//   node src/announcer.js --test 0x<address>     # posts a specific coin
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TOKEN = (process.env.TG_BOT_TOKEN || "").trim();
const CHAT = (process.env.TG_CHAT || "").trim();
const API = (process.env.ANNOUNCE_API_BASE || "https://api.robinlab.io").replace(/\/+$/, "");
const SITE = (process.env.ANNOUNCE_SITE_BASE || "https://robinlab.io").replace(/\/+$/, "");
const BANNER = (process.env.ANNOUNCE_BANNER_URL || "").trim();  // promo graphic posted on top of every post
const TG_API = (process.env.TG_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""); // override for tests
const GRADS = process.env.ANNOUNCE_GRADUATIONS !== "0";  // announce graduations too (default on)
const POLL_MS = Number(process.env.ANNOUNCE_POLL_MS || 30000);
const STATE = process.env.ANNOUNCE_STATE || "./data/announced.json";
const BACKLOG = process.env.ANNOUNCE_BACKLOG === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Persisted sets of already-announced token addresses (survive restarts). `seen` = launched, `grad` =
// graduated. Backward compatible with the old {seen:[...]} state file.
function loadState() {
  try {
    const j = JSON.parse(readFileSync(STATE, "utf8"));
    return { seen: new Set(j.seen || []), grad: new Set(j.graduated || []) };
  } catch { return null; }
}
function saveState(st) {
  try { mkdirSync(dirname(STATE), { recursive: true }); } catch {}
  try {
    writeFileSync(STATE, JSON.stringify({ seen: [...st.seen], graduated: [...st.grad], updated: Math.floor(Date.now() / 1000) }));
  } catch (e) { console.log("[announcer] state write failed:", e.message); }
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
// Prefer a USD market cap when present, else the ETH cap. NOTE: the current /api/coins does NOT return
// mcapUsd (there is no server-side price feed), so real posts render the ETH cap. The USD branch is
// forward-compatible for when a price is added; do not assume dollars show today.
const mcapOf = (c) => fmtUsd(c.mcapUsd) || (c.mcapEth != null ? `${Number(c.mcapEth).toFixed(3)} ETH` : null);

// Build the LAUNCH text for a coin (brand voice: no em-dashes, no emoji-spam, only true mechanics).
export function caption(c) {
  const sym = String(c.symbol || "").replace(/^\$+/, "");
  const link = `${SITE}/token.html?c=${c.token}`;
  const mc = mcapOf(c);
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

// Build the GRADUATION text. This is the payoff moment: the curve filled, liquidity migrated to a
// permanent Uniswap v3 floor, and the protocol paid the creator 0.5 ETH for graduating.
export function gradCaption(c) {
  const sym = String(c.symbol || "").replace(/^\$+/, "");
  const link = `${SITE}/token.html?c=${c.token}`;
  const mc = mcapOf(c);
  const lines = [
    `<b>${esc(c.name || "A coin")}</b> just GRADUATED on Robinhood Chain`,
    ``,
    `$${esc(sym)}`,
    `<code>${esc(c.token)}</code>`,
  ];
  if (mc) lines.push(`Market cap: ${esc(mc)}`);
  lines.push(
    ``,
    `It filled its curve and migrated into a permanent Uniswap v3 floor. The creator just earned 0.5 ETH for graduating. Robin Labs is the only launchpad that pays successful creators.`,
    ``,
    `Trade: ${link}`,
  );
  return lines.join("\n");
}

// Post one card to the channel: banner on top (album with the coin image second) when a BANNER is set,
// else the coin's own image, else plain text. Each step falls back to the next so a post never drops.
async function postCard(c, text) {
  const coinImg = c.image || (c.has_pfp ? `${API}/media/${c.token}/pfp` : null);
  const base = { chat_id: CHAT, parse_mode: "HTML", disable_web_page_preview: false };
  let ok = false;
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
  return ok;
}

export async function announce(c) {
  const ok = await postCard(c, caption(c));
  if (ok) console.log(`[announcer] posted launch ${c.symbol} (${c.token.slice(0, 10)})`);
  return ok;
}

export async function announceGrad(c) {
  const ok = await postCard(c, gradCaption(c));
  if (ok) console.log(`[announcer] posted graduation ${c.symbol} (${c.token.slice(0, 10)})`);
  return ok;
}

// Post any coins in `list` that aren't in `seenSet`, oldest-first, persisting as we go.
async function drain(list, seenSet, poster, st) {
  const fresh = (list || []).filter((c) => c && c.token && !seenSet.has(c.token.toLowerCase())).reverse();
  for (const c of fresh) {
    const ok = await poster(c);
    seenSet.add(c.token.toLowerCase());
    if (ok) saveState(st);          // persist as we go so a crash never re-announces
    await sleep(1200);              // gentle pace, well under Telegram's limits
  }
}

async function tick(st) {
  const jl = await getJson(`${API}/api/coins?sort=new&limit=25`);
  await drain(jl && jl.coins, st.seen, announce, st);
  if (GRADS) {
    const jg = await getJson(`${API}/api/coins?filter=graduated&sort=graduated&limit=25`);
    await drain(jg && jg.coins, st.grad, announceGrad, st);
  }
}

// Fetch a single coin for the manual test: a specific address if given (via the feed's own q search, so
// the shape matches), otherwise the newest coin.
async function fetchOne(which) {
  const addr = (which || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    const j = await getJson(`${API}/api/coins?q=${addr}&limit=1`);
    const c = j && j.coins && j.coins[0];
    if (c) return c;
  }
  const j = await getJson(`${API}/api/coins?sort=new&limit=1`);
  return (j && j.coins && j.coins[0]) || null;
}

// One-shot: post a single coin to the channel now, without reading or writing the "already announced"
// state. Lets you confirm the whole pipeline (creds, chat id, banner, image) works from the group.
async function testPost(which) {
  if (!TOKEN || !CHAT) { console.log("[announcer] test: set TG_BOT_TOKEN and TG_CHAT first."); process.exit(1); }
  const c = await fetchOne(which);
  if (!c || !c.token) { console.log("[announcer] test: no coin found to post (is the API reachable and are there any coins?)."); process.exit(1); }
  console.log(`[announcer] test: posting ${c.symbol} (${c.token}) to ${CHAT} ...`);
  const ok = await announce(c);
  if (ok) console.log("[announcer] test: OK — check your channel for the post.");
  else console.log("[announcer] test: FAILED. See the telegram error above. Most common cause: TG_CHAT must be a @publicusername or a numeric -100... id (NOT a display name), and the bot must be an ADMIN of that channel.");
  process.exit(ok ? 0 : 1);
}

async function main() {
  // Manual test mode: `--test [address]`.
  const ti = process.argv.indexOf("--test");
  if (ti !== -1) return testPost(process.argv[ti + 1]);

  if (!TOKEN || !CHAT) { console.log("[announcer] disabled (set TG_BOT_TOKEN and TG_CHAT to run)"); setInterval(() => {}, 1 << 30); return; }
  let st = loadState();
  if (st === null) {
    // First run: unless ANNOUNCE_BACKLOG=1, seed with whatever exists now so we don't spam the whole history.
    st = { seen: new Set(), grad: new Set() };
    if (!BACKLOG) {
      const jl = await getJson(`${API}/api/coins?sort=new&limit=200`);
      for (const c of ((jl && jl.coins) || [])) if (c && c.token) st.seen.add(c.token.toLowerCase());
      const jg = await getJson(`${API}/api/coins?filter=graduated&sort=graduated&limit=200`);
      for (const c of ((jg && jg.coins) || [])) if (c && c.token) st.grad.add(c.token.toLowerCase());
      console.log(`[announcer] first run: seeded ${st.seen.size} coins + ${st.grad.size} graduations (will only post NEW). Set ANNOUNCE_BACKLOG=1 to post the backlog.`);
    }
    saveState(st);
  }
  console.log(`[announcer] running -> ${CHAT}, polling ${API}/api/coins every ${POLL_MS}ms (launches${GRADS ? " + graduations" : ""})`);
  for (;;) {
    try { await tick(st); } catch (e) { console.log("[announcer] tick error:", e.message); }
    await sleep(POLL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
