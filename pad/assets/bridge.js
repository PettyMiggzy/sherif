// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs cross-chain buy — LI.FI routing to Robinhood Chain (4663).
//
// The user pays with any supported token on any supported source chain; LI.FI finds the best
// route (Across / Relay / deBridge / …) that bridges AND swaps on arrival, so the Robin Labs coin
// lands directly in the user's wallet on Robinhood Chain in one signature. Fully non-custodial:
// the user signs one tx on the source chain, we never hold funds.
//
// Verified live: LI.FI lists Robinhood Chain (id 4663, diamond 0xB477…4Af3) and returns real
// routes into it (e.g. Arbitrum ETH → CASHCAT on 4663 via Relay).
//
// This module is pure LI.FI + wallet glue (quote / status / execute). The UI lives in bridge.html.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "./ethers.min.js";
import * as Pad from "./wallet.js";
import { API_BASE } from "./config.js";

// Prefer our server-side key-proxy: it injects the LI.FI API key + our integrator/fee, so we avoid LI.FI's
// tiny keyless limit (75 requests / 2h / IP — the cause of the token-list fallback + intermittent quote
// failures). Fall back to li.quest directly if the proxy isn't enabled yet (404). Params already carry
// integrator/fee/toChain so the direct path works; the proxy just re-injects them server-side.
const PROXY = (API_BASE || "").replace(/\/+$/, "") + "/api/lifi";
const DIRECT = "https://li.quest/v1";
async function lifiFetch(name, { query, method = "GET", body, timeout = 12000 } = {}) {
  const qs = query ? "?" + query.toString() : "";
  const go = (base, path) => {
    const o = { method, headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) };
    if (body !== undefined) { o.body = JSON.stringify(body); o.headers["content-type"] = "application/json"; }
    return fetch(`${base}/${path}${qs}`, o);
  };
  try { const r = await go(PROXY, name); if (r.status !== 404) return r; } catch { /* proxy unreachable -> direct */ }
  return go(DIRECT, name === "routes" ? "advanced/routes" : name);
}
const INTEGRATOR = "labs";                      // LI.FI Portal integrator id (fee wallet configured in the Portal); CASE-SENSITIVE
const FEE = "0.01";                             // our 1% integrator fee -> the Portal-configured wallet (LI.FI adds its own 0.25%). No API key needed.
export const DEST_CHAIN = 4663;                  // Robinhood Chain
export const NATIVE = "0x0000000000000000000000000000000000000000";
const hex = (n) => "0x" + Number(n).toString(16);

// Curated source chains. Each carries the wallet_addEthereumChain params so we can add the chain if
// the user's wallet doesn't have it. Public RPCs only (the wallet broadcasts through them).
export const SRC_CHAINS = [
  { id: 1,     name: "Ethereum", short: "ETH",  coin: "ETH",  rpc: "https://eth.llamarpc.com",              exp: "https://etherscan.io" },
  { id: 8453,  name: "Base",     short: "BASE", coin: "ETH",  rpc: "https://mainnet.base.org",              exp: "https://basescan.org" },
  { id: 42161, name: "Arbitrum", short: "ARB",  coin: "ETH",  rpc: "https://arb1.arbitrum.io/rpc",          exp: "https://arbiscan.io" },
  { id: 10,    name: "Optimism", short: "OP",   coin: "ETH",  rpc: "https://mainnet.optimism.io",           exp: "https://optimistic.etherscan.io" },
  { id: 137,   name: "Polygon",  short: "POL",  coin: "POL",  rpc: "https://polygon-rpc.com",               exp: "https://polygonscan.com" },
  { id: 56,    name: "BNB Chain",short: "BNB",  coin: "BNB",  rpc: "https://bsc-dataseed.binance.org",      exp: "https://bscscan.com" },
];

// native + USDC per source chain (the two tokens that cover the overwhelming majority of bridge volume).
const USDC = {
  1:     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  10:    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  137:   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  56:    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
};
export function tokensFor(chainId) {
  const c = SRC_CHAINS.find((x) => x.id === chainId);
  const out = [{ addr: NATIVE, symbol: c ? c.coin : "ETH", decimals: 18, native: true }];
  if (USDC[chainId]) out.push({ addr: USDC[chainId], symbol: "USDC", decimals: 6, native: false });
  return out;
}
export const chainName = (id) => (SRC_CHAINS.find((x) => x.id === id) || {}).name || ("chain " + id);

// Full per-chain token list from LI.FI (hundreds of real, correctly-addressed tokens with logos),
// so the user can bridge from ANY supported token, not just native + USDC. Cached per chain.
const _tokCache = new Map();
export async function chainTokens(chainId) {
  if (_tokCache.has(chainId)) return _tokCache.get(chainId);
  let list = null;
  try {
    const r = await lifiFetch("tokens", { query: new URLSearchParams({ chains: String(chainId) }), timeout: 8000 });
    const j = await r.json();
    const raw = (j.tokens && j.tokens[String(chainId)]) || [];
    list = raw
      .filter((t) => t && t.symbol && t.address)
      .map((t) => ({
        addr: t.address, symbol: t.symbol, decimals: Number(t.decimals) || 18,
        native: t.address.toLowerCase() === NATIVE, logo: t.logoURI || null, priceUSD: Number(t.priceUSD) || 0,
      }));
  } catch { list = null; }
  if (!list || !list.length) list = tokensFor(chainId).map((t) => ({ ...t, logo: null, priceUSD: 0 }));
  // native first, then keep LI.FI's order (majors are front-loaded)
  list.sort((a, b) => (b.native - a.native));
  _tokCache.set(chainId, list);
  return list;
}
// The native token descriptor for a chain (used as the default source token).
export function nativeToken(chainId) {
  const t = tokensFor(chainId).find((x) => x.native) || { addr: NATIVE, symbol: "ETH", decimals: 18, native: true };
  return { ...t, logo: null };
}

// ── LI.FI quote ────────────────────────────────────────────────────────────────
// Returns a normalized object plus the raw LI.FI quote (needed verbatim for execution + status).
export async function quote({ fromChain, fromToken, fromAmount, fromAddress, toToken, preview = false, slippage = 0.01 }) {
  const qs = new URLSearchParams({
    fromChain: String(fromChain),
    toChain: String(DEST_CHAIN),
    fromToken, toToken,
    fromAmount: String(fromAmount),
    fromAddress,
    integrator: INTEGRATOR,
    fee: FEE,
    slippage: String(slippage),   // 4663 is thin-liquidity; never rely on LI.FI's default
  });
  if (preview) qs.set("skipSimulation", "true"); // pre-connect estimate: don't simulate against an unfunded placeholder (that is what triggers "no route could build a tx")
  const r = await lifiFetch("quote", { query: qs });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.transactionRequest) {
    const msg = (j && (j.message || j.error)) || `no route (HTTP ${r.status})`;
    throw new Error(msg);
  }
  const est = j.estimate || {};
  const act = j.action || {};
  const gasUSD = (est.gasCosts || []).reduce((s, g) => s + (+g.amountUSD || 0), 0);
  const feeUSD = (est.feeCosts || []).reduce((s, f) => s + (+f.amountUSD || 0), 0);
  return {
    raw: j,
    tool: j.tool,
    steps: (j.includedSteps || []).map((s) => s.tool).filter(Boolean),
    toAmount: est.toAmount,                 // in the dest token's smallest unit
    toAmountMin: est.toAmountMin,
    toDecimals: (act.toToken && +act.toToken.decimals) || 18,
    fromAmountUSD: est.fromAmountUSD,
    toAmountUSD: est.toAmountUSD,
    durationSec: est.executionDuration || 0,
    gasUSD, feeUSD,
    approvalAddress: est.approvalAddress || null,  // spender to approve for an ERC20 source token
  };
}

// ── LI.FI status (cross-chain delivery tracking) ────────────────────────────────
export async function status({ txHash, fromChain, toChain = DEST_CHAIN, bridge }) {
  const qs = new URLSearchParams({ txHash, fromChain: String(fromChain), toChain: String(toChain) });
  if (bridge) qs.set("bridge", bridge);
  const r = await lifiFetch("status", { query: qs });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("status unavailable");
  // j.status: NOT_FOUND | INVALID | PENDING | DONE | FAILED ; j.substatus for detail
  return { status: j.status, substatus: j.substatus, substatusMessage: j.substatusMessage,
    receiving: j.receiving || null, sending: j.sending || null };
}

// ── execution: switch to the source chain, approve if needed, sign the one bridge tx ────────────
const ERC20 = new ethers.Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount)",
]);

async function switchChain(eip, chainId) {
  const cur = await eip.request({ method: "eth_chainId" });
  if ((cur || "").toLowerCase() === hex(chainId)) return;
  const c = SRC_CHAINS.find((x) => x.id === chainId);
  try {
    await eip.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(chainId) }] });
  } catch (e) {
    if ((e && (e.code === 4902 || String(e.message || "").includes("Unrecognized"))) && c) {
      await eip.request({ method: "wallet_addEthereumChain", params: [{
        chainId: hex(chainId), chainName: c.name,
        nativeCurrency: { name: c.coin, symbol: c.coin, decimals: 18 },
        rpcUrls: [c.rpc], blockExplorerUrls: [c.exp],
      }] });
    } else { throw e; }
  }
}

// Read allowance via a public RPC for the source chain (the wallet may still be mid-switch).
async function erc20Allowance(chainId, token, owner, spender) {
  const c = SRC_CHAINS.find((x) => x.id === chainId);
  const rp = new ethers.JsonRpcProvider(c.rpc, chainId, { staticNetwork: true });
  const erc = new ethers.Contract(token, ERC20, rp);
  try { return await erc.allowance(owner, spender); } catch { return 0n; }
}

// Execute a quote. Calls onProgress(phase, detail) for UI: 'switch' | 'approve' | 'sign' | 'sent'.
// Returns { srcTxHash, fromChain, bridge }. The caller then polls status() until DONE.
export async function execute(q, { fromChain, fromToken, fromAmount, fromAddress, onProgress = () => {} } = {}) {
  const eip = Pad.rawEip();
  if (!eip) throw new Error("Connect your wallet first.");
  Pad.setBridgeMode(true);
  try {
    onProgress("switch", chainName(fromChain));
    await switchChain(eip, fromChain);

    // ERC20 source token → ensure allowance to LI.FI's spender.
    if (fromToken && fromToken.toLowerCase() !== NATIVE) {
      const spender = q.approvalAddress || q.raw.transactionRequest.to;
      const have = await erc20Allowance(fromChain, fromToken, fromAddress, spender);
      if (BigInt(have) < BigInt(fromAmount)) {
        onProgress("approve", null);
        const data = ERC20.encodeFunctionData("approve", [spender, BigInt(fromAmount)]);
        const apTx = await eip.request({ method: "eth_sendTransaction", params: [{ from: fromAddress, to: fromToken, data }] });
        await waitReceipt(fromChain, apTx);
      }
    }

    onProgress("sign", null);
    const tr = q.raw.transactionRequest;
    const params = { from: fromAddress, to: tr.to, data: tr.data };
    if (tr.value && tr.value !== "0x0" && tr.value !== "0") params.value = tr.value;
    // LI.FI already includes gasLimit/gasPrice where relevant; pass them through if present.
    if (tr.gasLimit) params.gas = tr.gasLimit;
    const srcTxHash = await eip.request({ method: "eth_sendTransaction", params: [params] });
    onProgress("sent", srcTxHash);
    return { srcTxHash, fromChain, bridge: q.tool };
  } finally {
    Pad.setBridgeMode(false);
  }
}

// Wait for a tx receipt on a source chain via its public RPC (used for the approval step).
async function waitReceipt(chainId, txHash) {
  const c = SRC_CHAINS.find((x) => x.id === chainId);
  const rp = new ethers.JsonRpcProvider(c.rpc, chainId, { staticNetwork: true });
  for (let i = 0; i < 60; i++) {
    try { const rc = await rp.getTransactionReceipt(txHash); if (rc) return rc; } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("approval is taking too long — check your wallet and retry");
}

export const fmtUnits = (wei, dec) => {
  try { return ethers.formatUnits(BigInt(wei), dec); } catch { return "0"; }
};
export const parseUnits = (amt, dec) => {
  try { return ethers.parseUnits(String(amt || "0").trim() || "0", dec); } catch { return 0n; }
};
