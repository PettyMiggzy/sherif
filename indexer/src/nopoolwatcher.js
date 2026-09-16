// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — no-pool-forever milestone watcher.
//
// A pad-v4 curve launched with noPoolForever fires a ONE-TIME NoPoolCheckpoint event inside
// graduate(), at its ~$34K FDV ceiling: the curve splits its would-be LP ETH 50/50 creator/platform
// and keeps trading forever inside its original price range — no real pool ever gets minted, so no
// aggregator (DexScreener etc.) auto-lists it. Buying the listing (DexScreener's $400 "update + 10x
// boost") is deliberately a human follow-up, not a contract concern — see ARC-FEES-AND-NOTES.md
// ("I don't know that you can make a contract do that... probably need an Oracle and it'd be a big
// bill"). This watcher's only job is telling a human the moment it happens, so they can go buy it.
//
// Reads NoPoolCheckpoint logs directly off the curves in NOPOOL_CURVES (comma-separated — pad-v4 has
// no factory-driven address discovery wired into this indexer yet, matching the same manual-allowlist
// convention supportkeeper.js uses for SUPPORT_CURVES). Posts to Telegram via the same Bot API
// announcer.js uses. Read-only: no wallet, no private key, no chain writes — same trust footprint as
// announcer.js.
//
// OFF unless TG_BOT_TOKEN and a chat (NOPOOL_TG_CHAT, else TG_CHAT) are set, AND NOPOOL_CURVES is
// non-empty. Run:  node src/nopoolwatcher.js
//   TG_BOT_TOKEN     the @BotFather bot token (SECRET, .env only) — same bot as announcer.js
//   NOPOOL_TG_CHAT   where to post. Defaults to TG_CHAT, but this is an operational "go buy the boost"
//                    alert for the team, not marketing copy — set it separately if it should land in
//                    an internal chat instead of the public announcement channel.
//   NOPOOL_CURVES    comma-separated RobinCurveV4 addresses to watch. "" (default) = watcher stays off.
// Optional:
//   NOPOOL_RPC       RPC url (default: the same RPC_URL this indexer already reads chain state from)
//   NOPOOL_POLL_MS   default 30000
//   NOPOOL_STATE     state file path (default ./data/nopool-announced.json)
//   NOPOOL_START_BLOCK  block a newly-added curve starts scanning from (default: the current head —
//                    skips history, so adding a curve here never dredges up an old checkpoint as "new")
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ethers } from "ethers";
import { CFG } from "./config.js";

const TOKEN = (process.env.TG_BOT_TOKEN || "").trim();
const CHAT = (process.env.NOPOOL_TG_CHAT || process.env.TG_CHAT || "").trim();
const TG_API = (process.env.TG_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""); // override for tests
const CURVES = (process.env.NOPOOL_CURVES || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s));
const RPC = process.env.NOPOOL_RPC || CFG.rpcUrl;
const POLL_MS = Number(process.env.NOPOOL_POLL_MS || 30000);
const STATE = process.env.NOPOOL_STATE || "./data/nopool-announced.json";
const START_BLOCK = process.env.NOPOOL_START_BLOCK ? Number(process.env.NOPOOL_START_BLOCK) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CURVE_ABI = [
  "event NoPoolCheckpoint(uint128 liquidityWithdrawn, uint128 liquidityRetained, uint256 toCreatorEth)",
  "function token() view returns (address)",
  "function currentCreator() view returns (address)",
];
const ERC20_ABI = ["function symbol() view returns (string)", "function name() view returns (string)"];

// Persisted per-curve scan cursor + a set of already-announced "curve:txHash:logIndex" keys (survives
// restarts without double-posting — same shape as announcer.js's state file).
function loadState() {
  try {
    const j = JSON.parse(readFileSync(STATE, "utf8"));
    return { seen: new Set(j.seen || []), cursor: j.cursor || {} };
  } catch { return { seen: new Set(), cursor: {} }; }
}
function saveState(st) {
  try { mkdirSync(dirname(STATE), { recursive: true }); } catch {}
  try {
    writeFileSync(STATE, JSON.stringify({ seen: [...st.seen], cursor: st.cursor, updated: Math.floor(Date.now() / 1000) }));
  } catch (e) { console.log("[nopoolwatcher] state write failed:", e.message); }
}

// Telegram Bot API call. Returns the parsed body or null. Never throws.
async function tg(method, params) {
  try {
    const r = await fetch(`${TG_API}/bot${TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    });
    const j = await r.json();
    if (!j.ok) console.log(`[nopoolwatcher] telegram ${method} error:`, j.description || JSON.stringify(j));
    return j.ok ? j : null;
  } catch (e) { console.log(`[nopoolwatcher] telegram ${method} threw:`, e.message); return null; }
}

const esc = (s) => String(s ?? "").replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c])); // HTML parse_mode

// Best-effort metadata for the alert. Any read failing (a nonstandard token, a stale RPC) still lets
// the alert go out with whatever it has — a checkpoint alert with a blank symbol beats no alert at all.
async function describeCurve(provider, curveAddr) {
  const c = new ethers.Contract(curveAddr, CURVE_ABI, provider);
  let sym = "", name = "", tokenAddr = "", creatorAddr = "";
  try { tokenAddr = await c.token(); } catch {}
  try { creatorAddr = await c.currentCreator(); } catch {}
  if (tokenAddr) {
    const t = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    try { sym = await t.symbol(); } catch {}
    try { name = await t.name(); } catch {}
  }
  return { sym, name, tokenAddr, creatorAddr };
}

function caption({ sym, name, tokenAddr, creatorAddr, curveAddr, toCreatorEth }) {
  const label = sym ? `$${sym}` : (name || curveAddr);
  const lines = [`<b>${esc(label)}</b> just hit its no-pool milestone checkpoint`, ``];
  if (tokenAddr) lines.push(`Token: <code>${esc(tokenAddr)}</code>`);
  lines.push(`Curve: <code>${esc(curveAddr)}</code>`);
  if (creatorAddr) lines.push(`Creator: <code>${esc(creatorAddr)}</code>`);
  lines.push(
    ``,
    `Creator was paid ${esc(ethers.formatEther(toCreatorEth))} ETH. The platform's matching half is claimable too.`,
    ``,
    `ACTION: buy the DexScreener $400 update + 10x boost for this token now — it will not list itself.`,
  );
  return lines.join("\n");
}

async function announceCheckpoint(provider, curveAddr, ev, st) {
  const key = `${curveAddr}:${ev.transactionHash}:${ev.logIndex}`;
  if (st.seen.has(key)) return;
  const info = await describeCurve(provider, curveAddr);
  const text = caption({ ...info, curveAddr, toCreatorEth: ev.args.toCreatorEth });
  const ok = await tg("sendMessage", { chat_id: CHAT, parse_mode: "HTML", text });
  if (ok) console.log(`[nopoolwatcher] posted checkpoint for ${info.sym || curveAddr} (tx ${ev.transactionHash})`);
  // mark seen regardless of send success: a Telegram outage should not spin on the same checkpoint
  // forever — the address is still in the alert text on the state file if a human needs to recheck.
  st.seen.add(key);
  saveState(st);
}

async function tick(provider, iface, st) {
  const head = await provider.getBlockNumber();
  const topic = iface.getEvent("NoPoolCheckpoint").topicHash;
  for (const curveAddr of CURVES) {
    const from = st.cursor[curveAddr] ?? (START_BLOCK ?? head);
    if (from > head) continue;
    let logs;
    try {
      logs = await provider.getLogs({ address: curveAddr, topics: [topic], fromBlock: from, toBlock: head });
    } catch (e) { console.log(`[nopoolwatcher] getLogs failed for ${curveAddr}:`, e.message); continue; }
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      await announceCheckpoint(provider, curveAddr, { args: parsed.args, transactionHash: log.transactionHash, logIndex: log.index }, st);
    }
    st.cursor[curveAddr] = head + 1;
  }
  saveState(st);
}

async function main() {
  if (!TOKEN || !CHAT) { console.log("[nopoolwatcher] disabled (set TG_BOT_TOKEN and NOPOOL_TG_CHAT/TG_CHAT to run)"); setInterval(() => {}, 1 << 30); return; }
  if (!CURVES.length) { console.log("[nopoolwatcher] disabled (set NOPOOL_CURVES to the RobinCurveV4 addresses to watch)"); setInterval(() => {}, 1 << 30); return; }
  const provider = new ethers.JsonRpcProvider(RPC);
  const iface = new ethers.Interface(CURVE_ABI);
  const st = loadState();
  console.log(`[nopoolwatcher] running -> ${CHAT}, watching ${CURVES.length} curve(s) every ${POLL_MS}ms`);
  for (;;) {
    try { await tick(provider, iface, st); } catch (e) { console.log("[nopoolwatcher] tick error:", e.message); }
    await sleep(POLL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
