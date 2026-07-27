// ─────────────────────────────────────────────────────────────────────────────
// LI.FI cross-chain proxy — the server-side half of the Robin Labs bridge.
//
// The browser calls our /api/lifi/* instead of li.quest directly. This module injects the SECRET
// x-lifi-api-key (never reaches the browser) AND our integrator id + fee, and hard-locks the
// destination to Robinhood Chain. Injecting the key also moves us off LI.FI's keyless limit
// (75 requests / 2h / IP — the root cause of the bridge's intermittent token-list fallback and
// quote failures) onto our per-key bucket (100 req/min).
//
// We LOCK: toChain = Robinhood Chain, integrator = ours, fee = ours (so a third party can't
// repurpose our key + fee for arbitrary bridges). Everything else is passed through.
// ─────────────────────────────────────────────────────────────────────────────
import { CFG } from "./config.js";

const BASE = CFG.lifiApiBase;
const DEST = String(CFG.lifiDestChain);
const headers = () => ({ accept: "application/json", "x-lifi-api-key": CFG.lifiApiKey });
const allowed = (id) => CFG.lifiSrcChains.includes(Number(id));

async function forward(path, { method = "GET", query, body } = {}) {
  let url = BASE + path;
  if (query) url += "?" + query.toString();
  const opts = { method, headers: headers(), signal: AbortSignal.timeout(12000) };
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  const r = await fetch(url, opts);
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON upstream */ }
  return { status: r.status, json: json ?? { error: "bridge upstream error" } };
}

// GET /api/lifi/quote — lock destination + inject our integrator/fee; pass fromToken/toToken/amount/address/slippage/skipSimulation through.
export async function handleQuote(q) {
  const p = new URLSearchParams(q || {});
  if (!allowed(p.get("fromChain"))) return { status: 400, json: { error: "source chain not allowed" } };
  p.set("toChain", DEST);
  p.set("integrator", CFG.lifiIntegrator);
  p.set("fee", CFG.lifiFee);
  return forward("/quote", { query: p });
}

// GET /api/lifi/tokens?chains=… — only our allowed source chains (+ the dest chain).
export async function handleTokens(q) {
  const p = new URLSearchParams(q || {});
  const chains = (p.get("chains") || "").split(",").map(Number).filter((n) => allowed(n) || n === CFG.lifiDestChain);
  if (!chains.length) return { status: 400, json: { error: "no allowed chains" } };
  const p2 = new URLSearchParams(); p2.set("chains", chains.join(","));
  return forward("/tokens", { query: p2 });
}

// GET /api/lifi/connections — tokens that can ACTUALLY route into Robinhood Chain (LI.FI's own answer to
// "which fromTokens bridge to chain X"). Destination is forced to Robinhood Chain.
export async function handleConnections(q) {
  const p = new URLSearchParams(q || {});
  if (p.get("fromChain") && !allowed(p.get("fromChain"))) return { status: 400, json: { error: "source chain not allowed" } };
  p.set("toChain", DEST);
  return forward("/connections", { query: p });
}

// GET /api/lifi/status — cross-chain delivery tracking.
export async function handleStatus(q) {
  const p = new URLSearchParams(q || {});
  p.set("toChain", DEST);
  return forward("/status", { query: p });
}

// POST /api/lifi/routes — /advanced/routes for pre-connect previews (fromAddress optional, no simulation);
// lock destination + inject integrator/fee into options.
export async function handleRoutes(body) {
  const b = body && typeof body === "object" ? { ...body } : {};
  if (!allowed(b.fromChainId)) return { status: 400, json: { error: "source chain not allowed" } };
  b.toChainId = CFG.lifiDestChain;
  b.options = { ...(b.options || {}), integrator: CFG.lifiIntegrator, fee: Number(CFG.lifiFee) };
  return forward("/advanced/routes", { method: "POST", body: b });
}

export const _internal = { forward, allowed };
