// ─────────────────────────────────────────────────────────────────────────────
// Uniswap Trading API proxy — the server-side half of Robin Labs' top-token swaps.
//
// The browser NEVER sees the Uniswap API key or the trade-api host. It calls our own
// /api/uni/{quote,swap,check_approval}; this module injects the secret x-api-key AND our
// 1.25% integrator fee, hard-locks inputs to chain 4663 + a curated token allowlist,
// asserts the fee actually applied (else 502 — never a fee-less trade) and the swap
// targets the real Universal Router, then forwards to the Uniswap Trading API.
//
// Pure logic only (validate → inject → forward → assert); the IO (rate-limit, body read,
// CORS/send) lives in api.js so this stays testable. All addresses compared lowercased.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";

export const NATIVE = "0x0000000000000000000000000000000000000000";
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
export const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904"; // v2.1.1 on 4663 (verified live)
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // WETH9 on 4663 (the fee leg for native swaps)

const lc = (x) => String(x || "").toLowerCase();
const isAddr = (x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const isPosIntStr = (x) => typeof x === "string" && /^[0-9]{1,40}$/.test(x) && (() => { try { return BigInt(x) > 0n; } catch { return false; } })();

// native ETH + the curated allowlist, all lowercased. Only these can be a swap leg.
function allowedSet() { return new Set([NATIVE, ...CFG.uniTokens, ...CFG.uniStockTokens]); }

/// Is either leg a tokenized stock? Those trade fee-free — see `uniStockTokens` in config for why.
function isStockPair(tokenIn, tokenOut) {
  const S = new Set(CFG.uniStockTokens);
  return S.has(lc(tokenIn)) || S.has(lc(tokenOut));
}

// The fee entry the RESPONSE must contain. NOTE the field asymmetry Uniswap uses:
//   REQUEST integratorFees uses `bips`; RESPONSE aggregatedOutputs uses `bps`. Assert on `bps`.
function feeApplied(quoteObj, stockPair) {
  const outs = quoteObj && quoteObj.aggregatedOutputs;
  if (!Array.isArray(outs)) return false;
  // A STOCK PAIR MUST COME BACK WITH NO INTEGRATOR FEE AT ALL. Checked rather than assumed: we do not
  // request one, but the answer comes from an upstream API and this is the one property that decides
  // whether the venue takes a cut of a securities trade. If a fee ever appears here — a cached quote, an
  // upstream default, a mistake of ours — the trade is refused rather than served fee-bearing.
  if (stockPair) return !outs.some((o) => o && o.fee === "INTEGRATOR");
  return outs.some((o) => o && lc(o.recipient) === CFG.uniFeeRecipient && Number(o.bps) === CFG.uniFeeBips && o.fee === "INTEGRATOR");
}

// Build the upstream /v1/quote body: force EXACT_INPUT + our chain, INJECT our fee (client's is ignored),
// and pass a clamped slippage if the client supplied one.
function buildQuoteUpstream(b) {
  const body = {
    type: "EXACT_INPUT",
    amount: String(b.amount),
    tokenInChainId: CFG.uniChainId,
    tokenOutChainId: CFG.uniChainId,
    tokenIn: lc(b.tokenIn),
    tokenOut: lc(b.tokenOut),
    swapper: lc(b.swapper),
  };
  // SERVER-injected; the client's is ignored. Omitted entirely on a stock pair rather than sent as zero —
  // a fee of zero is still a fee entry, and the point is that none is ever asked for.
  if (!isStockPair(b.tokenIn, b.tokenOut)) {
    body.integratorFees = [{ recipient: CFG.uniFeeRecipient, bips: CFG.uniFeeBips }];
  }
  const slip = Number(b.slippageTolerance);
  if (Number.isFinite(slip) && slip >= 0.1 && slip <= 15) body.slippageTolerance = slip;
  return body;
}

// Validate a client quote request. Returns an error string or null.
function validateQuote(b) {
  if (!b || typeof b !== "object") return "bad body";
  if (b.type !== undefined && b.type !== "EXACT_INPUT") return "only EXACT_INPUT is supported";
  if (!isAddr(b.tokenIn) || !isAddr(b.tokenOut)) return "bad token address";
  if (!isAddr(b.swapper)) return "bad swapper address";
  if (!isPosIntStr(String(b.amount))) return "amount must be a positive integer (wei)";
  const A = allowedSet();
  const tin = lc(b.tokenIn), tout = lc(b.tokenOut);
  if (!A.has(tin) || !A.has(tout)) return "token not allowlisted";
  if (tin === tout) return "tokenIn == tokenOut";
  if ([tin, tout].filter((t) => t === NATIVE).length !== 1) return "exactly one leg must be native ETH";
  return null;
}

// Validate the quote object echoed back on a /swap request (never trust the client's quote blindly):
// chain, both legs allowlisted with exactly one native, and OUR fee still present.
function validateSwapQuote(q) {
  if (!q || typeof q !== "object") return "missing quote";
  if (Number(q.chainId) !== CFG.uniChainId) return "wrong chain";
  const tin = lc(q.input && q.input.token), tout = lc(q.output && q.output.token);
  const A = allowedSet();
  if (!A.has(tin) || !A.has(tout)) return "quote token not allowlisted";
  if ([tin, tout].filter((t) => t === NATIVE).length !== 1) return "quote must have exactly one native leg";
  // Both directions matter: our fee must be present on an ordinary pair, and ABSENT on a stock pair.
  if (!feeApplied(q, isStockPair(tin, tout))) {
    return isStockPair(tin, tout) ? "stock trades must not carry a fee" : "fee not present on quote";
  }
  return null;
}

// Universal Router: execute(bytes commands, bytes[] inputs [, uint256 deadline]). Each command byte's low
// 6 bits (& 0x3f) is the command type. The integrator fee is taken by a top-level "pay a portion to
// recipient" command whose input is abi.encode(address currency, address recipient, uint256 bips):
//   - Classic PAY_PORTION = 0x06, with bips as a plain integer (125 = 1.25%).
//   - The Universal Router deployed on Robinhood Chain (4663) uses command 0x07 for the SAME purpose, but
//     encodes bips as a 1e18-scaled WAD fraction (125 bips = 0.0125e18 = 125 * 1e14 = 12500000000000000).
// Both must be recognised; both carry the same (currency, recipient, bips) tuple. Verified against live
// buy (WRAP_ETH, V3/V4 swap, 0x07, SWEEP) and sell (V4 swap, 0x07, UNWRAP_WETH) calldata on 4663.
const UR_IFACE = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs)",
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);
const PAY_PORTION = 0x06;   // bips as a plain integer
const FEE_TAKE = 0x07;      // 4663's UR: same tuple, bips as a 1e18 WAD
const COMMAND_TYPE_MASK = 0x3f;

// Assert the BUILT calldata actually pays OUR fee: a PAY_PORTION command whose recipient is our fee wallet,
// whose bips == our configured fee, AND whose token is a real leg of THIS swap ({tokenIn, tokenOut, WETH}).
// A doctored quote can otherwise leave the cosmetic aggregatedOutputs summary at 125 bips while the real
// PAY_PORTION carries ~1 bip (bips attack) OR targets a decoy token the router holds ~0 of, so 125 bips *
// ~0 balance = ~0 fee actually paid (token attack). Both must be blocked; decoding the command is the only
// reliable guard. `tokenIn`/`tokenOut` come from the (already-validated) quote legs.
function feeInCalldata(data, tokenIn, tokenOut) {
  let parsed;
  try { parsed = UR_IFACE.parseTransaction({ data }); } catch { return false; }
  if (!parsed) return false;
  let commands, inputs;
  try { commands = ethers.getBytes(parsed.args.commands); inputs = parsed.args.inputs; } catch { return false; }
  if (!inputs || commands.length !== inputs.length) return false;

  // A STOCK PAIR INVERTS THIS CHECK. Everywhere else the job is "prove our fee really is being paid"; on a
  // tokenized security it is "prove NOTHING is being paid to us". The summary the API returns is cosmetic —
  // the same reason this function exists to decode the real commands rather than trust it — so the absence
  // of a fee has to be read out of the calldata too, not inferred from what we asked for.
  if (isStockPair(tokenIn, tokenOut)) {
    for (let i = 0; i < commands.length; i++) {
      const ct = commands[i] & COMMAND_TYPE_MASK;
      if (ct === PAY_PORTION || ct === FEE_TAKE) return false; // any fee command at all disqualifies it
    }
    return true;
  }
  // The fee is legitimately taken on ONE specific leg, by direction:
  //   native-in BUY  -> the OUTPUT token only (fee taken on what the user receives, AFTER the swap).
  //   native-out SELL -> WETH (or the input token) before the unwrap.
  // Binding to the OUTPUT-only for a buy is what closes the WETH-decoy strip: a PAY_PORTION on WETH after
  // the router already swapped its WETH away pays 125 bips * ~0 = ~0, so WETH must NOT be an accepted buy leg.
  const tin = lc(tokenIn), tout = lc(tokenOut);
  let allowedFeeTokens;
  if (tin === NATIVE) allowedFeeTokens = new Set([tout]);              // buy: output token only
  else if (tout === NATIVE) allowedFeeTokens = new Set([WETH]);        // sell: WETH only - tin is swapped AWAY, so a
                                                                       // PAY_PORTION on tin post-swap pays 125 bips * ~0 (same decoy class as the buy side)
  else allowedFeeTokens = new Set([tin, tout, WETH]);                  // (guarded elsewhere to one native leg)
  allowedFeeTokens.delete(NATIVE);
  allowedFeeTokens.delete("");
  // Accept either fee-command encoding: bips as a plain integer (125) OR as a 1e18-scaled WAD (125 * 1e14).
  // Compare with BigInt — the WAD (1.25e16) exceeds Number.MAX_SAFE_INTEGER, so Number(bips) would round and
  // could false-match. The strict recipient + leg-token match still blocks any strip/decoy: a command that
  // doesn't pay OUR wallet OUR bips on a real leg simply isn't counted, so broadening the opcode is safe.
  const feeBips = BigInt(CFG.uniFeeBips);
  const feeWad = feeBips * 100000000000000n; // bips -> 1e18 fraction (x 1e14)
  const coder = ethers.AbiCoder.defaultAbiCoder();
  for (let i = 0; i < commands.length; i++) {
    const ct = commands[i] & COMMAND_TYPE_MASK;
    if (ct !== PAY_PORTION && ct !== FEE_TAKE) continue;
    try {
      const [token, recipient, bips] = coder.decode(["address", "address", "uint256"], inputs[i]);
      let b; try { b = BigInt(bips); } catch { continue; }
      if (lc(recipient) === CFG.uniFeeRecipient && (b === feeBips || b === feeWad) && allowedFeeTokens.has(lc(token))) return true;
    } catch { /* not a readable fee command; keep scanning */ }
  }
  return false;
}

async function forward(routePath, body) {
  const r = await fetch(CFG.uniApiBase + routePath, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CFG.uniApiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(9000),
  });
  let json = null;
  try { json = await r.json(); } catch { /* upstream returned non-JSON */ }
  return { status: r.status, json };
}

// ── route handlers: each returns { status, json } ──────────────────────────────

export async function handleQuote(clientBody) {
  const err = validateQuote(clientBody);
  if (err) return { status: 400, json: { error: err } };
  const { status, json } = await forward("/v1/quote", buildQuoteUpstream(clientBody));
  if (status < 200 || status >= 300 || !json) return { status: status || 502, json: json || { error: "upstream error" } };
  // Never hand back a quote whose fee is wrong in EITHER direction: a missing fee on an ordinary pair is
  // a free trade, and a present fee on a stock pair is us taking a cut of a securities trade. Both refuse.
  const stock = isStockPair(clientBody.tokenIn, clientBody.tokenOut);
  if (!feeApplied(json.quote, stock)) {
    return { status: 502, json: { error: stock ? "stock quote came back fee-bearing; refused" : "fee not applied; trading temporarily unavailable" } };
  }
  return { status: 200, json };
}

export async function handleSwap(clientBody) {
  if (!clientBody || typeof clientBody !== "object" || !clientBody.quote) return { status: 400, json: { error: "missing quote" } };
  const qErr = validateSwapQuote(clientBody.quote);
  if (qErr) return { status: 400, json: { error: qErr } };
  // Only forward the fields the API expects; drop anything else the client tacked on.
  const upstream = { quote: clientBody.quote };
  if (clientBody.permitData) upstream.permitData = clientBody.permitData;
  if (clientBody.signature) upstream.signature = clientBody.signature;
  const { status, json } = await forward("/v1/swap", upstream);
  if (status < 200 || status >= 300 || !json) return { status: status || 502, json: json || { error: "upstream error" } };
  const s = json.swap;
  if (!s || lc(s.to) !== UNIVERSAL_ROUTER || Number(s.chainId) !== CFG.uniChainId) {
    return { status: 502, json: { error: "unexpected swap target" } };
  }
  // Decode the built calldata and require a PAY_PORTION to OUR recipient at OUR bips ON A REAL LEG of this
  // swap - so a doctored quote can't reduce, strip, or decoy-token the fee while leaving the cosmetic
  // aggregatedOutputs summary intact.
  const q = clientBody.quote;
  if (!feeInCalldata(s.data, q.input && q.input.token, q.output && q.output.token)) {
    return { status: 502, json: { error: "fee missing or reduced in swap calldata" } };
  }
  // For a native-in (buy) EXACT_INPUT, the tx value must equal the quoted input amount.
  const tin = lc(clientBody.quote.input && clientBody.quote.input.token);
  if (tin === NATIVE) {
    try {
      if (BigInt(s.value) !== BigInt(clientBody.quote.input.amount)) return { status: 502, json: { error: "swap value mismatch" } };
    } catch { return { status: 502, json: { error: "bad swap value" } }; }
  }
  return { status: 200, json };
}

const APPROVE_IFACE = new ethers.Interface(["function approve(address spender, uint256 amount)"]);

export async function handleApproval(clientBody) {
  const b = clientBody || {};
  const token = b.token, wallet = b.walletAddress;
  if (!isAddr(token) || !isAddr(wallet)) return { status: 400, json: { error: "bad token or wallet" } };
  if (!allowedSet().has(lc(token))) return { status: 400, json: { error: "token not allowlisted" } };
  if (b.amount !== undefined && !isPosIntStr(String(b.amount))) return { status: 400, json: { error: "bad amount" } };
  const upstream = { walletAddress: lc(wallet), token: lc(token), chainId: CFG.uniChainId };
  if (b.amount !== undefined) upstream.amount = String(b.amount);
  const { status, json } = await forward("/v1/check_approval", upstream);
  if (status < 200 || status >= 300 || !json) return { status: status || 502, json: json || { error: "upstream error" } };
  // If an approval tx is returned, it MUST be an approve() of the sell token to the canonical Permit2.
  const ap = json.approval;
  if (ap) {
    if (lc(ap.to) !== lc(token)) return { status: 502, json: { error: "approval target is not the token" } };
    try {
      const dec = APPROVE_IFACE.parseTransaction({ data: ap.data });
      if (!dec || lc(dec.args[0]) !== PERMIT2) return { status: 502, json: { error: "approval spender is not Permit2" } };
    } catch { return { status: 502, json: { error: "unreadable approval calldata" } }; }
  }
  return { status: 200, json };
}

// exported for tests
export const _internal = { feeApplied, validateQuote, validateSwapQuote, buildQuoteUpstream, allowedSet, feeInCalldata };
