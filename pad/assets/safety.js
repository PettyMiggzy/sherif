// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Pad — safety layer  (GoPlus token security + tx simulation)
//
// Goal: users (and their wallets) should never be left guessing whether a coin or
// a transaction is safe — so we pre-vet BOTH, in the open, before anyone signs.
//
// Two independent sources, because each covers the other's blind spot:
//
//   1. [GoPlus]   The same token-security scanner most wallets (MetaMask/Blowfish/
//                 Blockaid-style) consult. GoPlus supports Robinhood Chain (4663),
//                 so our coins are scanned like any major chain: honeypot, taxes,
//                 mintability, ownership take-back, pausable transfers, etc. If our
//                 coins are clean here, wallets have nothing to red-flag.
//                 Caveat: GoPlus needs time to INDEX a brand-new token — for the
//                 first minutes after launch its result is empty. That's what (2) is for.
//
//   2. [Template] Every Robin Labs coin is deployed by our factory from ONE audited
//                 LaunchToken template — not arbitrary user code. So we can verify a
//                 coin is a genuine Robin Labs launch (its record exists in our
//                 factory) and therefore CANNOT be a honeypot: fixed supply (no mint),
//                 no owner take-back, no pausable transfers, sells never blocked after
//                 the opening window, LP locked at graduation. This is true from block
//                 one, before GoPlus indexes anything.
//
//   [Tx sim]      Every state-changing action is simulated with eth_call BEFORE the
//                 wallet is asked to sign (see wallet.js guardedSend). simulate() here
//                 exposes that result so the UI can show "simulated ✓ — you'll receive
//                 ~X" instead of a scary unknown. A tx that would revert never reaches
//                 the wallet, so the user never sees the wallet's red failure screen.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "./ethers.min.js";
import { CHAIN, CONTRACTS, ABIS, GOPLUS_APP_KEY } from "./config.js";

const GOPLUS = "https://api.gopluslabs.io/api/v1";
// Read via a FallbackProvider so a coin's safety verdict survives an indexer outage: it prefers the
// cached proxy (priority 1) but fails over to the public RPC, instead of silently degrading every coin
// to "UNVERIFIED" when api.robinlab.io is down but the public RPC is healthy.
const _read = (() => {
  const cfgs = CHAIN.rpc.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, CHAIN.id, { staticNetwork: true }),
    priority: i + 1, stallTimeout: 1500, weight: 1,
  }));
  return cfgs.length > 1 ? new ethers.FallbackProvider(cfgs, CHAIN.id, { quorum: 1 }) : cfgs[0].provider;
})();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const truthy = (v) => v === 1 || v === "1" || v === true;
const pct = (taxStr) => { const n = Number(taxStr); return Number.isFinite(n) ? n * 100 : null; }; // GoPlus tax is a fraction

// GoPlus rate limits anon calls; an app-key (optional) raises them. token_security works without one.
function gpHeaders() {
  const h = { accept: "application/json" };
  if (GOPLUS_APP_KEY) h.Authorization = GOPLUS_APP_KEY;
  return h;
}

// Never let a slow/blocked GoPlus call hang the UI — the template + tx-sim checks stand on their own.
const timeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

/// Raw GoPlus token-security record for our chain, or null if unsupported / not-yet-indexed / error.
export async function goPlusToken(token) {
  if (!isAddr(token)) return null;
  try {
    const r = await fetch(`${GOPLUS}/token_security/${CHAIN.id}?contract_addresses=${token}`, { headers: gpHeaders(), signal: timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.code !== 1 || !j.result) return null;
    const rec = j.result[token.toLowerCase()] || j.result[token];
    // GoPlus returns {} for a token it hasn't indexed yet — treat as "no data", not "unsafe".
    return rec && Object.keys(rec).length ? rec : null;
  } catch { return null; }
}

/// GoPlus malicious-address flag for an arbitrary address (used to vouch for our own router/contracts).
export async function goPlusAddress(addr) {
  if (!isAddr(addr)) return null;
  try {
    const r = await fetch(`${GOPLUS}/address_security/${addr}?chain_id=${CHAIN.id}`, { headers: gpHeaders(), signal: timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.code === 1 ? j.result : null;
  } catch { return null; }
}

/// Is this token a genuine Robin Labs launch (our audited template), and what's its on-chain tax?
async function templateAndTax(token) {
  const out = { isOurCoin: false, buyBps: null, sellBps: null, pool: null };
  try {
    const router = new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _read);
    const c = await router.configOf(token);
    out.isOurCoin = !!c.set;
    out.buyBps = Number(c.buyBps);
    out.sellBps = Number(c.sellBps);
    out.pool = c.pool;
  } catch {}
  return out;
}

// One check row the UI renders. level: "ok" | "warn" | "info".
const chk = (level, label, detail) => ({ level, label, detail });

/// Full, normalized safety report for a coin — GoPlus + template + tax, merged and de-jargoned.
/// Shape: { token, verdict:"safe"|"caution"|"unknown", source, checks:[{level,label,detail}], gp }
export async function scanToken(token) {
  const [gp, tt] = await Promise.all([goPlusToken(token), templateAndTax(token)]);
  const checks = [];
  let bad = 0, warn = 0;

  // 1) Robin Labs template — the strongest immediate guarantee (works before GoPlus indexes).
  if (tt.isOurCoin) {
    checks.push(chk("ok", "Verified Robin Labs coin", "Our audited LaunchToken template — not custom code. Fixed 1B supply, no mint, no owner kill-switch, LP locked at graduation."));
  } else {
    checks.push(chk("info", "Not a Robin Labs launch", "This token wasn't launched on Robin Labs, so the template guarantees below don't apply — rely on the GoPlus scan."));
  }

  // 2) Honeypot — can you actually sell? (the scariest red flag)
  if (gp && "is_honeypot" in gp) {
    if (truthy(gp.is_honeypot) || truthy(gp.cannot_sell_all)) { checks.push(chk("warn", "Honeypot risk", "GoPlus flags this token as hard/impossible to sell.")); bad++; }
    else checks.push(chk("ok", "Not a honeypot", "GoPlus confirms sells go through."));
  } else if (tt.isOurCoin) {
    checks.push(chk("ok", "Sells always open", "The template never blocks a holder's sell — the anti-snipe guard is buy-side only and auto-expires."));
  }

  // 3) Trading tax
  if (tt.buyBps != null) {
    const b = tt.buyBps / 100, s = tt.sellBps / 100;
    const level = (tt.buyBps > 400 || tt.sellBps > 400) ? "warn" : "ok";
    if (level === "warn") warn++;
    checks.push(chk(level, `Trading fee ${b}% buy / ${s}% sell`, "Set at launch and immutable — the 4% cap is enforced on-chain. No hidden fee-on-transfer (Uniswap v3 forbids it)."));
  } else if (gp && (gp.buy_tax != null || gp.sell_tax != null)) {
    const b = pct(gp.buy_tax), s = pct(gp.sell_tax);
    const level = ((b ?? 0) > 10 || (s ?? 0) > 10) ? "warn" : "ok";
    if (level === "warn") warn++;
    checks.push(chk(level, `Trading fee ${b}% buy / ${s}% sell`, "Reported by GoPlus."));
  }

  // 4) Mint / ownership take-back / pausable — GoPlus signals (skipped cleanly for our fixed template).
  if (gp) {
    if (truthy(gp.is_mintable)) { checks.push(chk("warn", "Mintable supply", "GoPlus: the owner can mint more tokens.")); warn++; }
    if (truthy(gp.can_take_back_ownership) || truthy(gp.hidden_owner)) { checks.push(chk("warn", "Owner can reclaim control", "GoPlus flags a hidden/recoverable owner.")); bad++; }
    if (truthy(gp.transfer_pausable)) { checks.push(chk("warn", "Transfers can be paused", "GoPlus: an owner can freeze transfers.")); warn++; }
    if (truthy(gp.slippage_modifiable)) { checks.push(chk("warn", "Tax can be changed", "GoPlus: the tax rate is modifiable.")); warn++; }
    if (gp.is_open_source != null) checks.push(chk(truthy(gp.is_open_source) ? "ok" : "info", truthy(gp.is_open_source) ? "Contract verified (open source)" : "Source not verified yet", ""));
  } else if (tt.isOurCoin) {
    checks.push(chk("ok", "Fixed supply · no owner kill-switch", "The template has no mint, no pause, no ownership take-back, and no modifiable tax."));
  }

  const verdict = bad > 0 ? "caution" : (gp || tt.isOurCoin) ? (warn > 0 ? "caution" : "safe") : "unknown";
  const source = gp ? (tt.isOurCoin ? "GoPlus + Robin Labs template" : "GoPlus") : (tt.isOurCoin ? "Robin Labs template" : "unavailable");
  return { token, verdict, source, checks, gp };
}

/// Tx SIMULATION preflight — eth_call the exact contract call the user is about to sign. Returns the decoded
/// result on success, or a friendly reason on revert, WITHOUT ever asking the wallet to sign. This is what keeps
/// a doomed tx (honeypot sell, slippage, anti-snipe cap) from ever reaching the wallet's scary red screen.
export async function simulate(contract, method, args, valueWei = 0n, from = undefined) {
  try {
    const res = await contract[method].staticCall(...args, { value: valueWei, ...(from ? { from } : {}) });
    return { ok: true, result: res };
  } catch (e) {
    const raw = (e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || "").toString();
    return { ok: false, error: raw || "the transaction would revert" };
  }
}

// ── tiny self-contained UI: a safety panel any page can drop in ──────────────
const DOT = { ok: "#48d16a", warn: "#f5c542", info: "#7f8570", caution: "#f5c542" };
const HEAD = {
  safe: { c: "#48d16a", t: "SAFE", s: "Pre-vetted — clean on every check we run." },
  caution: { c: "#f5c542", t: "REVIEW", s: "Mostly clean, but read the flagged items before you trade." },
  unknown: { c: "#7f8570", t: "UNVERIFIED", s: "We couldn't fully scan this token — trade carefully." },
};

/// Render the report into an element (or return the HTML string if no element given).
export function renderSafety(report, el) {
  const h = HEAD[report.verdict] || HEAD.unknown;
  const rows = report.checks.map((c) =>
    `<div style="display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06)">
       <span style="flex:none;width:8px;height:8px;border-radius:50%;margin-top:5px;background:${DOT[c.level] || DOT.info}"></span>
       <div><div style="font-weight:700;font-size:.84rem">${c.label}</div>${c.detail ? `<div style="color:#93a382;font-size:.76rem;line-height:1.4;margin-top:1px">${c.detail}</div>` : ""}</div>
     </div>`).join("");
  const html =
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
       <span style="font-family:ui-monospace,Menlo,monospace;font-size:.68rem;letter-spacing:.14em;font-weight:800;color:#10140a;background:${h.c};padding:3px 9px;border-radius:999px">🛡 ${h.t}</span>
       <span style="color:#93a382;font-size:.78rem">${h.s}</span>
     </div>
     ${rows}
     <div style="color:#7f8570;font-size:.68rem;margin-top:9px">Scanned via <b style="color:#93a382">${report.source}</b>. Not financial advice.</div>`;
  if (el) el.innerHTML = html;
  return html;
}

/// Convenience: scan + render in one call.
export async function mountSafety(el, token) {
  if (el) el.innerHTML = `<div style="color:#7f8570;font-size:.8rem">🛡 Scanning safety…</div>`;
  try { const rep = await scanToken(token); renderSafety(rep, el); return rep; }
  catch { if (el) el.innerHTML = `<div style="color:#7f8570;font-size:.8rem">Safety scan unavailable right now.</div>`; }
}

if (typeof window !== "undefined") {
  window.RobinSafety = { goPlusToken, goPlusAddress, scanToken, simulate, renderSafety, mountSafety };
}
