// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Pad — wallet + signing layer  (audit target)
//
// This is the EVM translation of our Phantom/Blowfish "stay-unflagged" rulebook.
// Robinhood Chain is an EVM L2, so the primitives differ (no SystemProgram /
// Jupiter / mint keypair) but the SAFETY RULES map 1:1. Each rule is enforced
// here and labelled [Rule N] so it can be checked line-by-line. See SECURITY.md
// for the full mapping.
//
//   [Rule 1] No approve / delegate / setAuthority in a user-signed tx.
//            → Launch + BUY are 100% approval-free (native ETH in). SELL needs
//              the one unavoidable EVM approval: an EXACT-amount approve to the
//              canonical, verified router only — never infinite, never to us.
//   [Rule 2] One recipient, one signer, feePayer = the user. No fan-out.
//            → launch() hits ONE contract; swaps hit ONE router. No splitting in
//              the signed tx; any fee/payout math is off-chain or in-protocol.
//   [Rule 3] Fees ride the protocol's native fee, not a side transfer.
//            → Our 1% is the Uniswap LP fee tier, collected in-protocol. There is
//              never an extra transfer instruction bolted onto a user's tx.
//   [Rule 4] Swaps are the standard single-signer shape. Nothing custom.
//   [Guard ] Simulate + balance-check BEFORE asking a wallet to sign, so the
//            user never sees the scary red "insufficient funds / blocked" screen.
//   [Link  ] signMessage (personal_sign) for ownership/Telegram linking — free,
//            never a transaction, kept entirely separate from the payment path.
// ─────────────────────────────────────────────────────────────────────────────

// ethers v6.13.4 is VENDORED locally (assets/ethers.min.js) — no runtime CDN
// dependency, so the whole app is self-contained and auditable offline.
import { ethers } from "./ethers.min.js";
import {
  CHAIN, CONTRACTS, ABIS, TOTAL_SUPPLY,
  GAS_BUFFER_WEI, isDeployed, API_BASE, hasApi,
} from "./config.js";

// Re-export the config helper so pages doing `import * as Pad from './wallet.js'`
// can call `Pad.hasApi()` (a namespace import only sees a module's own exports,
// not what it imports). create.html relies on this to decide whether to upload
// the coin profile after launch.
export { hasApi };

let _provider = null; // ethers BrowserProvider
let _signer = null;
let _account = null;

// A read-only provider for quotes/simulation even before the user connects. When more
// than one RPC is configured, use a FallbackProvider so reads prefer the indexer proxy
// (priority 1, paid + cached) and automatically fail over to the public RPC if it stalls.
const _read = (() => {
  const cfgs = CHAIN.rpc.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, CHAIN.id, { staticNetwork: true }),
    priority: i + 1, stallTimeout: 1500, weight: 1,
  }));
  return cfgs.length > 1 ? new ethers.FallbackProvider(cfgs, CHAIN.id, { quorum: 1 }) : cfgs[0].provider;
})();
const REWARD_LEG_BPS = 25; // 0.25% router reward leg (buy→traders / sell→holders), carved before the swap when the vault is set

// ── provider detection: prefer Phantom's EVM provider, then any injected wallet ─
function injected() {
  if (typeof window === "undefined") return null;
  // Phantom exposes its EVM provider at window.phantom.ethereum
  if (window.phantom?.ethereum) return window.phantom.ethereum;
  if (window.ethereum) return window.ethereum;
  return null;
}

function friendly(err, label) {
  // Turn raw RPC/revert errors into calm, honest messages — never leak a stack.
  const raw = (err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || "").toString();
  const s = raw.toLowerCase();
  if (err?.code === "ACTION_REJECTED" || s.includes("user rejected") || s.includes("user denied"))
    return new Error("You cancelled the signature — nothing was sent.");
  if (s.includes("insufficient funds"))
    return new Error("Not enough ETH to cover this and gas. Top up and try again.");
  if (s.includes("maxwallet") || s.includes("maxtx") || s.includes("cooldown") || s.includes("antisnip"))
    return new Error("The opening anti-snipe window caps buy size right now. Try a smaller amount or wait a minute.");
  if (s.includes("slippage") || s.includes("too little received") || s.includes("price"))
    return new Error("Price moved past your slippage. Raise slippage a touch or retry.");
  return new Error(label ? `${label} failed: ${raw || "unknown error"}` : (raw || "Transaction failed."));
}

// ── mobile: no wallet is injected in a normal mobile browser — a wallet only
// injects window.ethereum inside its OWN in-app browser. So on mobile we offer
// to reopen the dapp inside the user's wallet app via a deep link. ──────────────
function isMobile() {
  return typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}
function walletDeepLinks() {
  const url = location.href, hostPath = location.host + location.pathname + location.search;
  return [
    { name: "Phantom", href: `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}` },
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${hostPath}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
  ];
}
function showMobileWalletPrompt() {
  if (typeof document === "undefined" || document.getElementById("rl-wallet-modal")) return;
  const links = walletDeepLinks();
  const wrap = document.createElement("div");
  wrap.id = "rl-wallet-modal";
  wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)";
  wrap.innerHTML = `<div style="background:#0c1107;border:1px solid rgba(220,233,5,.3);border-radius:18px 18px 0 0;max-width:460px;width:100%;padding:22px 20px 30px;font-family:system-ui,-apple-system,sans-serif;color:#f4f7ee;box-shadow:0 -10px 40px rgba(0,0,0,.5)">
      <div style="font-weight:800;font-size:1.12rem;margin-bottom:4px">Open in your wallet</div>
      <div style="color:#93a382;font-size:.9rem;line-height:1.45;margin-bottom:16px">A mobile browser can't connect a wallet directly. Tap your wallet to open Robin Labs inside its built-in browser, then hit Connect there.</div>
      <div style="display:flex;flex-direction:column;gap:9px">
        ${links.map((l) => `<a href="${l.href}" style="display:block;text-align:center;background:#dce905;color:#0a0e05;font-weight:800;padding:14px;border-radius:12px;text-decoration:none">Open in ${l.name}</a>`).join("")}
      </div>
      <button id="rl-wallet-close" style="width:100%;margin-top:12px;background:none;border:1px solid rgba(255,255,255,.15);color:#93a382;padding:11px;border-radius:12px;font-weight:600;cursor:pointer">Cancel</button>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("#rl-wallet-close").addEventListener("click", close);
}

// ── connect + chain guard ───────────────────────────────────────────────────
export async function connect() {
  const eip = injected();
  if (!eip) {
    // Mobile browser with no injected wallet → guide them into the wallet app
    // instead of a dead-end error. Returns null (no throw) so the UI stays calm.
    if (isMobile()) { showMobileWalletPrompt(); return null; }
    throw new Error("No wallet found. Install Phantom or another EVM wallet, then reload.");
  }

  await eip.request({ method: "eth_requestAccounts" });
  await ensureChain(eip);

  _provider = new ethers.BrowserProvider(eip, "any");
  _signer = await _provider.getSigner();
  _account = await _signer.getAddress();

  // keep UI in sync if the user switches account/chain in their wallet
  eip.removeAllListeners?.("accountsChanged");
  eip.on?.("accountsChanged", () => location.reload());
  eip.on?.("chainChanged", () => location.reload());
  return _account;
}

async function ensureChain(eip) {
  const current = await eip.request({ method: "eth_chainId" });
  if (current?.toLowerCase() === CHAIN.hexId) return;
  try {
    await eip.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hexId }] });
  } catch (e) {
    if (e?.code === 4902 || (e?.message || "").includes("Unrecognized")) {
      await eip.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CHAIN.hexId, chainName: CHAIN.name, nativeCurrency: CHAIN.currency,
          // write-capable RPC only — the wallet broadcasts txs through this, never our read proxy
          rpcUrls: CHAIN.walletRpcUrls || CHAIN.rpc, blockExplorerUrls: [CHAIN.explorer],
        }],
      });
    } else { throw e; }
  }
}

export const account = () => _account;
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

// ── [Link] ownership / Telegram binding — a signature, NOT a transaction ──────
// Free, never hits the tx surface, never flagged. The backend verifies the
// signature to bind wallet ↔ Telegram. We keep this completely separate from any
// payment so the "expensive" tx surface is only ever a real payment.
export async function linkTelegram(handle) {
  if (!_signer) await connect();
  const nonce = ethers.hexlify(ethers.randomBytes(8));
  const message =
    `Robin Labs Pad — link this wallet to Telegram\n` +
    `Telegram: ${handle}\n` +
    `Wallet: ${_account}\n` +
    `Nonce: ${nonce}\n` +
    `This is a free signature, not a transaction. It moves no funds.`;
  const signature = await _signer.signMessage(message); // personal_sign
  return { message, signature, address: _account };
}

// ── coin profiles (creator-signed off-chain metadata: image, banner, socials) ──
// The message the coin's dev signs to authorize a profile update. MUST byte-match
// the indexer (indexer/src/api.js profileMessage) or the signature won't verify.
export function profileMessage(token, p) {
  const canon = JSON.stringify({
    description: p.description || "",
    telegram: p.telegram || "",
    twitter: p.twitter || "",
    website: p.website || "",
    pfp: p.pfp || "",
    banner: p.banner || "",
    ts: p.ts,
  });
  return `Robin Labs — set coin profile\ntoken: ${String(token).toLowerCase()}\nts: ${p.ts}\ndigest: ${ethers.id(canon)}`;
}

/// Save a coin's profile. Only the coin's creator (dev) can — it's a free signature,
/// no funds move. `fields`: { description, telegram, twitter, website, pfp, banner }
/// where pfp/banner are base64 data: URLs (or omitted to leave the existing image).
export async function setCoinProfile(token, fields = {}) {
  if (!hasApi()) throw new Error("Profiles save once the indexer API is configured (API_BASE).");
  if (!_signer) await connect();
  const payload = {
    description: String(fields.description || "").slice(0, 280),
    telegram: String(fields.telegram || "").trim().slice(0, 200),
    twitter: String(fields.twitter || "").trim().slice(0, 200),
    website: String(fields.website || "").trim().slice(0, 200),
    pfp: fields.pfp || "",
    banner: fields.banner || "",
    ts: Math.floor(Date.now() / 1000),
  };
  const signature = await _signer.signMessage(profileMessage(token, payload));
  const res = await fetch(`${API_BASE.replace(/\/+$/, "")}/api/coin/${token}/meta`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, signature }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `profile save failed (${res.status})`);
  return j.profile;
}

/// One coin's full record from the indexer (name, symbol, mcapEth, progress, graduated,
/// ticks, …), or null. Lets the coin page render market cap / price / stage / bond even
/// when the public RPC is overloaded and the direct curveInfo() call fails.
export async function coin(token) {
  if (!hasApi()) return null;
  try { const j = await apiGet(`/api/coin/${token}`); return j.coin || null; }
  catch { return null; }
}

/// A wallet's holdings from the indexer's holder index (coins it launched or traded,
/// with an approximate balance). Returns null if the API/endpoint is unavailable, so the
/// caller can fall back to scanning balances directly. `null` (no api) vs `[]` (nothing held).
export async function holdings(addr) {
  if (!hasApi()) return null;
  try { const j = await apiGet(`/api/holdings/${addr}`); return Array.isArray(j.coins) ? j.coins : null; }
  catch { return null; }
}

/// A coin's holders (top N + count) from the holder index, or null.
export async function coinHolders(token, limit = 20) {
  if (!hasApi()) return null;
  try { return await apiGet(`/api/coin/${token}/holders?limit=${limit}`); }
  catch { return null; }
}

/// Read a coin's saved profile (image/banner URLs + socials), or null.
export async function getCoinProfile(token) {
  if (!hasApi()) return null;
  try { const j = await apiGet(`/api/coin/${token}/meta`); return j.profile || null; }
  catch { return null; }
}

// ── the guard: simulate + balance-check BEFORE any signature ──────────────────
// Returns the sent tx (caller awaits .wait()). Throws a friendly error if the tx
// would revert OR the wallet can't cover value+gas — so the user never sees the
// wallet's red screen for what is really just "not enough ETH".
// Robinhood Chain (an Arbitrum Orbit L2) has two quirks that break a wallet's default signing path, and both
// are fatal to the LAUNCH tx specifically (it's our heaviest call, ~13M gas):
//   (a) a 2^24 (16,777,216) PER-TRANSACTION gas cap — NOT a block limit. eth_estimateGas can return a figure
//       ABOVE that cap (~36M) even for a tx that only burns ~13M and succeeds, so the wallet's own estimate
//       makes it look like the tx can't fit and it aborts.
//   (b) no eth_maxPriorityFeePerGas (returns -32601 "method not found"). MetaMask's EIP-1559 (type-2) path
//       calls it unconditionally; when it throws, MetaMask's fee + balance state gets corrupted and the user
//       sees a phantom "insufficient funds / no ETH" screen for a wallet that is fully funded.
// The fix is to hand the wallet a fully-priced LEGACY (type-0) transaction — explicit gasLimit (clamped under
// the per-tx cap) AND explicit gasPrice from eth_gasPrice — so there is nothing left for it to estimate and it
// never touches the missing 1559 RPC. This is exactly the shape that succeeded from the console. The tx is only
// charged what it actually burns; the unused gas headroom is refunded.
const TX_GAS_CAP = 16_000_000n; // just under the 2^24 (16,777,216) per-tx ceiling; ~13M launch fits with headroom

async function guardedSend(contract, method, args, valueWei, label) {
  const value = valueWei ?? 0n;

  // 1) simulate the exact call (eth_call). Catches contract reverts up-front.
  try { await contract[method].staticCall(...args, { value }); }
  catch (e) { throw friendly(e, label); }

  // 2) gas limit — estimate for a tight fit, but CLAMP hard to the per-tx cap and fall back to it when the
  //    estimate over-shoots or fails (the L2's estimate is unreliable on our heavy calls). Estimate via the
  //    read provider so a wallet-side estimateGas fault (-32603) can't abort us here.
  let gas = TX_GAS_CAP;
  try {
    const rc = contract.connect(_read);
    gas = await rc[method].estimateGas(...args, { value, from: _account });
  } catch {}
  let gasLimit = (gas * 12n) / 10n;
  if (gasLimit > TX_GAS_CAP) gasLimit = TX_GAS_CAP;

  // 3) legacy gas price (never eth_maxPriorityFeePerGas — the chain lacks it). getFeeData()
  // works on both JsonRpcProvider and FallbackProvider; the raw eth_gasPrice call is only a
  // secondary and only when the provider actually exposes .send() (FallbackProvider doesn't).
  let gasPrice = 0n;
  try { gasPrice = (await _read.getFeeData()).gasPrice ?? 0n; } catch {}
  if (gasPrice <= 0n && typeof _read.send === "function") { try { gasPrice = BigInt(await _read.send("eth_gasPrice", [])); } catch {} }

  // 4) balance check — the whole point: refuse locally, kindly, if it won't fit.
  const bal = await _provider.getBalance(_account);
  const gasCost = gasLimit * gasPrice;
  const need = value + gasCost + GAS_BUFFER_WEI;
  if (bal < need) {
    const fmt = (w) => (+ethers.formatEther(w)).toFixed(4);
    throw new Error(`Not enough ETH. This needs ≈ ${fmt(need)} ETH (incl. gas); you have ${fmt(bal)}.`);
  }

  // 5) send — single signer, feePayer = the user, one recipient [Rules 2 & 4], as a fully-priced LEGACY tx so
  //    the wallet has nothing to estimate and never calls the missing 1559 RPC.
  const overrides = { value, gasLimit, type: 0 };
  if (gasPrice > 0n) overrides.gasPrice = gasPrice;
  try {
    return await contract[method](...args, overrides);
  } catch (e) { throw friendly(e, label); }
}

// Legacy-tx overrides for user-signed calls that DON'T go through guardedSend
// (approve). The chain lacks eth_maxPriorityFeePerGas, so a default type-2 tx
// throws -32601 and corrupts the wallet's fee/balance state. Force a fully-priced
// legacy tx (type:0 + explicit gasPrice) exactly like guardedSend.
async function legacyOverrides() {
  let gasPrice = 0n;
  try { gasPrice = (await _read.getFeeData()).gasPrice ?? 0n; } catch {}
  if (gasPrice <= 0n && typeof _read.send === "function") { try { gasPrice = BigInt(await _read.send("eth_gasPrice", [])); } catch {} }
  const o = { type: 0 };
  if (gasPrice > 0n) o.gasPrice = gasPrice;
  return o;
}

// ── LAUNCH — one call, one recipient, optional dev buy, approval-free [Rule 1] ─
// devBuyEth: string ETH amount to spend on the creator's OWN opening buy (≤2%,
// enforced + excess-refunded by the contract). "0" = no dev buy.
// tax: {buyBps, sellBps, walletBps, floorBps, burnBps, projectWallet} — the
// project's self-set tax (≤4%/side; splits sum to 100%). Omitting it still charges the
// 1% floor — clampBps enforces a 100 bps minimum, so every coin pays at least 1% buy & sell.
export async function launch({ name, symbol, dev, devBuyEth = "0", tax }) {
  if (!_signer) await connect();
  if (!isDeployed("padFactory"))
    throw new Error("The launch contract isn't live yet — the Pad is in pre-deploy audit.");
  const value = devBuyEth && Number(devBuyEth) > 0 ? ethers.parseEther(String(devBuyEth)) : 0n;
  const factory = new ethers.Contract(CONTRACTS.padFactory, ABIS.padFactory, _signer);
  const t = normalizeTax(tax, dev || _account);
  const params = { name, symbol, dev: dev || _account, tax: t };
  const tx = await guardedSend(factory, "launch", [params], value, "Launch");
  return tx; // await tx.wait() then Pad.launchedTokenOf(receipt) for the new coin address
}

/// Pull the new coin's address out of a launch receipt (the factory's Launched event).
export function launchedTokenOf(receipt) {
  const iface = new ethers.Interface(ABIS.padFactory);
  for (const log of receipt?.logs || []) {
    if (String(log.address || "").toLowerCase() !== CONTRACTS.padFactory.toLowerCase()) continue;
    try { const p = iface.parseLog(log); if (p?.name === "Launched") return p.args.token; } catch { /* not this event */ }
  }
  return null;
}

// Fill in a valid tax tuple. clampBps floors buy/sell at the 1% (100 bps) minimum, so even a
// "no-tax" coin still pays 1%/side; the allocation must sum to 100% (the contract requires it),
// so default it all to the wallet bucket.
function normalizeTax(tax, devAddr) {
  const t = tax || {};
  const buyBps = clampBps(t.buyBps), sellBps = clampBps(t.sellBps);
  let walletBps = +t.walletBps || 0, floorBps = +t.floorBps || 0, burnBps = +t.burnBps || 0;
  if (walletBps + floorBps + burnBps !== 10000) { walletBps = 10000; floorBps = 0; burnBps = 0; }
  const projectWallet = t.projectWallet && /^0x[0-9a-fA-F]{40}$/.test(t.projectWallet) ? t.projectWallet : devAddr;
  return { buyBps, sellBps, walletBps, floorBps, burnBps, projectWallet };
}
// every coin pays at least the default 1% (100 bps); the contract enforces the same floor
const clampBps = (v) => Math.max(100, Math.min(400, Math.round(+v || 100)));

function routerRead() { return new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _read); }

/// Read a coin's on-chain tax so the UI can show it before trading.
export async function getTax(token) {
  const c = await routerRead().configOf(token);
  return {
    pool: c.pool, curve: c.curve, projectWallet: c.projectWallet, set: c.set,
    buyBps: Number(c.buyBps), sellBps: Number(c.sellBps),
    walletBps: Number(c.walletBps), floorBps: Number(c.floorBps), burnBps: Number(c.burnBps),
  };
}

// A decimal amount ethers.parseEther/parseUnits will accept. A JS number below ~1e-6
// stringifies to exponential ("1e-7"), which parseUnits/parseEther reject with a cryptic
// "invalid FixedNumber string value" BEFORE our friendly() cleanup ever runs — so we
// normalise to a plain, non-exponential decimal string first. Plain strings pass through
// untouched (full precision kept for "sell max"); an empty/zero amount stays "0".
function plainAmount(x) {
  const s = String(x ?? "").trim();
  if (!s) return "0";
  if (!/[eE]/.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return "0";
  return n.toFixed(18).replace(/\.?0+$/, "") || "0";
}

// ── BUY — native ETH in, no ERC20 approval, tokens straight to the buyer [Rule 1]
// The PadRouter takes the project's buy tax from msg.value, then swaps the rest.
export async function buy({ token, ethAmount, slippagePct = 8 }) {
  if (!_signer) await connect();
  requireRouter();
  const value = ethers.parseEther(plainAmount(ethAmount));
  const c = await getTax(token);
  // subtract the project fee AND the 0.25% router reward leg (carved before the swap once rewardVault is set);
  // harmless when legs are off (only makes minOut 0.25% more lenient, dwarfed by the slippage haircut).
  const net = (value * BigInt(10000 - c.buyBps - REWARD_LEG_BPS)) / 10000n; // what actually hits the pool
  const minOut = await quoteMinOut({ pool: c.pool, tokenIn: CONTRACTS.weth, tokenOut: token, amountIn: net, slippagePct });
  const router = new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer);
  return guardedSend(router, "buy", [token, minOut], value, "Buy");
}

// ── SELL — the single, isolated, EXACT-amount approval to OUR verified router ──
/// The connected wallet's balance of a coin, as an EXACT decimal string (18-dp).
/// Returned as a string so "sell max" can round-trip to the precise wei (Number()
/// would lose precision on large balances); callers Number() it for display/percent.
export async function tokenBalance(token, who) {
  const addr = who || _account;
  if (!addr) return "0";
  try {
    const erc = new ethers.Contract(token, ABIS.erc20, _read);
    return ethers.formatUnits(await erc.balanceOf(addr), 18);
  } catch { return "0"; }
}

// EVM has no approval-free way to sell a standard ERC20 through an AMM, so this
// is the ONE approval in the app: exact amount (never MaxUint), to our own
// PadRouter only, simulated first. The sell tax comes off the ETH out.
export async function sell({ token, tokenAmount, slippagePct = 8 }) {
  if (!_signer) await connect();
  requireRouter();
  const erc = new ethers.Contract(token, ABIS.erc20, _signer);
  const amountIn = ethers.parseUnits(plainAmount(tokenAmount), 18);

  const allowance = await erc.allowance(_account, CONTRACTS.padRouter);
  if (allowance < amountIn) {
    const atx = await erc.approve(CONTRACTS.padRouter, amountIn, await legacyOverrides()); // exact amount, our router; legacy tx (no 1559 on this chain)
    await atx.wait();
  }

  const c = await getTax(token);
  const gross = await quoteMinOut({ pool: c.pool, tokenIn: token, tokenOut: CONTRACTS.weth, amountIn, slippagePct });
  const minOutEth = (gross * BigInt(10000 - c.sellBps - REWARD_LEG_BPS)) / 10000n; // guard on the post-tax + post-leg ETH
  const router = new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer);
  return guardedSend(router, "sell", [token, amountIn, minOutEth], 0n, "Sell");
}

// ── quoting ───────────────────────────────────────────────────────────────────
// Prefer an on-chain QuoterV2 (exact). Fallback: spot price from the pool's
// slot0 with a generous haircut — a single-sided curve fills WORSE than spot, so
// we widen slippage to avoid nuisance reverts. Wire a Quoter for production.
async function quoteMinOut({ pool, tokenIn, tokenOut, amountIn, slippagePct }) {
  try {
    const p = new ethers.Contract(pool, ABIS.pool, _read);
    const [slot0, token0] = await Promise.all([p.slot0(), p.token0()]);
    const sqrt = slot0.sqrtPriceX96;
    const Q96 = 2n ** 96n;
    // price1per0 = (sqrt/2^96)^2  (token1 per token0). Scale by 1e18 for integer math.
    const price1per0 = (sqrt * sqrt * (10n ** 18n)) / (Q96 * Q96);
    const inIs0 = tokenIn.toLowerCase() === token0.toLowerCase();
    // expected out at spot (ignores curve depth) then a wide safety haircut
    let out = inIs0 ? (amountIn * price1per0) / (10n ** 18n) : (amountIn * (10n ** 18n)) / price1per0;
    const bufferPct = BigInt(Math.round((slippagePct + 6) * 100)); // + curve buffer
    const minOut = (out * (10000n - bufferPct)) / 10000n;
    if (minOut <= 0n) throw new Error("couldn't price this trade");
    return minOut;
  } catch (e) {
    // Never trade with a 0 slippage floor — that invites a sandwich. Fail loudly instead.
    throw new Error("Couldn't compute a safe price for this trade — try again in a moment.");
  }
}

function requireRouter() {
  if (!isDeployed("padRouter"))
    throw new Error("Trading opens when the Pad goes live — the router isn't set yet (pre-deploy audit).");
}

// ── dev-buy sizing: convert the create-form % into an ETH amount to send ──────
// The contract takes ETH (not a %), buys up to a ~2% price cap, and refunds any
// excess. We estimate the ETH for the chosen % from the launch price and stay a
// hair under 2% so the contract's hard cap never reverts. Purely a UI estimate;
// the chain is the source of truth and refunds overpay.
export function estimateDevBuyEth(pct) {
  const clamped = Math.max(0, Math.min(1.9, Number(pct) || 0)); // keep under the 2% cap
  // Launch price ≈ 1e-9 ETH/token (START_TICK ~ -207200). Buying P% of a 1e9
  // supply across the opening slice averages ~1.6× the start price. This is a
  // deliberately rough, safe overestimate; excess is refunded on-chain.
  const tokens = (clamped / 100) * Number(TOTAL_SUPPLY);
  const avgPrice = 1e-9 * 1.6;
  return (tokens * avgPrice).toFixed(6);
}

// ── curve state: graduation progress, mcap, the dev's target ──────────────────
const WETH_LC = CONTRACTS.weth.toLowerCase();
// WETH per token from a pool's sqrtPriceX96, respecting token/WETH ordering.
function priceFromSqrt(sqrt, token) {
  const Q96 = 2n ** 96n;
  const p1per0 = Number((sqrt * sqrt * 10n ** 18n) / (Q96 * Q96)) / 1e18; // token1 per token0
  return token.toLowerCase() < WETH_LC ? p1per0 : (p1per0 > 0 ? 1 / p1per0 : 0); // WETH per token
}

/// Read a coin's live graduation state for the trade page + browse cards.
export async function curveInfo(curve, token) {
  const c = new ethers.Contract(curve, ABIS.curve, _read);
  // Graduation is ceiling-only: `ready()` (authoritative, on-chain) flips true ONLY when the tick
  // reaches gradTick (~4.2 ETH). We read startTick + gradTick purely to draw the 0→100% progress bar.
  const [graduated, ready, startTick, gradTick, poolAddr, bond, dev, seedTime] =
    await Promise.all([
      c.graduated(), c.ready(), c.startTick(), c.gradTick(),
      c.pool(), c.bond(), c.dev(), c.seedTime(),
    ]);
  const p = new ethers.Contract(poolAddr, ABIS.pool, _read);
  const slot0 = await p.slot0();
  const tick = Number(slot0.tick);
  const st = Number(startTick), cl = Number(gradTick);
  const span = Math.abs(cl - st) || 1;
  const frac = (t) => Math.max(0, Math.min(1, Math.abs(t - st) / span)); // 0 at start … 1 at ceiling
  const wethPerToken = priceFromSqrt(slot0.sqrtPriceX96, token);
  return {
    graduated, ready, bond, dev, seedTime: Number(seedTime), pool: poolAddr, tick,
    mcapEth: wethPerToken * 1e9, wethPerToken,
    progress: frac(tick), // position along the curve (0..1)
    gradTick: cl, startTick: st,
  };
}

/// A dev's uncollected sell-fee escrow (native ETH), for the "collect / burn" panel.
export async function devEscrow(token) {
  return new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _read).devEscrow(token);
}

// ── graduate() — the permissionless "graduate" button (anyone can fire it) ─────
export async function graduate(curve) {
  if (!_signer) await connect();
  return guardedSend(new ethers.Contract(curve, ABIS.curve, _signer), "graduate", [], 0n, "Graduate");
}


// ── creator fee controls — collect to the wallet, or buy+burn ─────────────────
export async function withdrawDev(token) {
  if (!_signer) await connect();
  return guardedSend(new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer), "withdrawDev", [token], 0n, "Collect fees");
}
export async function burnDev(token) {
  if (!_signer) await connect();
  return guardedSend(new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer), "burnDev", [token], 0n, "Burn fees");
}

/// Newest-first list of every coin launched on the pad, straight from the chain.
/// This is the always-available fallback; prefer feed() which uses the indexer
/// API (name/symbol/volume/sorting in one call) when one is configured.
export async function listCoins(max = 60) {
  const f = new ethers.Contract(CONTRACTS.padFactory, ABIS.padFactory, _read);
  const n = Number(await f.tokenCount());
  const idxs = [];
  for (let i = n - 1; i >= Math.max(0, n - max); i--) idxs.push(i);
  const tokens = await Promise.all(idxs.map((i) => f.allTokens(i)));
  const recs = await Promise.all(tokens.map((t) => f.recordOf(t)));
  return recs.map((r) => ({ token: r.token, curve: r.curve, dev: r.dev, at: Number(r[3]) })); // r[3]=Record.at (see feed())
}

// ── indexer API client (optional; graceful fallback to direct RPC) ──────────
async function apiGet(path) {
  if (!hasApi()) throw new Error("no api");
  const res = await fetch(`${API_BASE.replace(/\/+$/, "")}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`api ${res.status}`);
  return res.json();
}

/// The browse feed — one server-sorted, offset-paginated page at a time, so the
/// board scales to any number of coins (the client never loads them all).
/// sort:   new | old | trending | top | progress
/// filter: all | live | final | graduated
/// Returns { coins, total }. `offset` advances pages; `limit` sizes each page.
export async function feed({ sort = "new", filter = "all", q = "", limit = 24, offset = 0 } = {}) {
  if (hasApi()) {
    try {
      const params = new URLSearchParams({ sort, filter, limit: String(limit), offset: String(offset) });
      if (q) params.set("q", q);
      const r = await apiGet(`/api/coins?${params}`);
      return { source: "api", coins: r.coins || [], total: r.total ?? null };
    } catch (e) {
      // Indexer configured but unreachable — fall through to reading the chain directly
      // so the board still shows coins (just without the rich sorts/volume/images).
      console.warn("feed: indexer unreachable, falling back to direct RPC —", e?.message || e);
    }
  }
  // Fallback with no indexer: page the factory list newest-first. Rich sorts
  // (volume/trending/mcap) need the indexer, but new/old + paging work on-chain.
  // Pull one page's worth from the correct end of the factory list.
  const f = new ethers.Contract(CONTRACTS.padFactory, ABIS.padFactory, _read);
  const n = Number(await f.tokenCount());
  const oldestFirst = sort === "old";
  // A search query OR a non-"all" filter can't be honoured within a single page's worth of reads
  // (a match — or a graduated coin — may sit anywhere in the list), so scan the whole factory list
  // in those cases and filter + slice below. The default (all coins, no query) stays lean and pages
  // one slice at a time.
  const applyFilter = filter && filter !== "all";
  const scanAll = !!q || applyFilter;
  const want = scanAll ? n : limit;
  const base = scanAll ? 0 : offset;
  const idxs = [];
  for (let k = 0; k < want; k++) {
    const i = oldestFirst ? base + k : n - 1 - base - k;
    if (i < 0 || i >= n) break;
    idxs.push(i);
  }
  const tokens = await Promise.all(idxs.map((i) => f.allTokens(i)));
  const [recs, metas] = await Promise.all([
    Promise.all(tokens.map((t) => f.recordOf(t))),
    Promise.all(tokens.map((t) => tokenMeta(t).catch(() => ({ name: "Token", symbol: "?" })))),
  ]);
  // Read each coin's real graduation state (the curve's on-chain flag) so the Live/Graduated tabs
  // filter correctly during an indexer outage — but only when a filter is active, so the default
  // board never pays for the extra reads.
  const grads = applyFilter
    ? await Promise.all(recs.map((r) => new ethers.Contract(r.curve, ABIS.curve, _read).graduated().catch(() => false)))
    : null;
  let coins = recs.map((r, i) => ({
    token: r.token, curve: r.curve, dev: r.dev,
    name: metas[i].name, symbol: metas[i].symbol,
    launchTs: Number(r[3]), graduated: grads ? !!grads[i] : false, // r[3] = Record.at — ethers Result `.at` collides with Array.prototype.at
  }));
  let total = n;
  if (scanAll) {
    if (q) {
      const s = q.toLowerCase();
      coins = coins.filter((c) => c.name?.toLowerCase().includes(s) || c.symbol?.toLowerCase().includes(s) || c.token.toLowerCase().includes(s));
    }
    // Same filter semantics as the API path: live = still on the curve, graduated = done. "final"
    // (final stretch) needs curve progress the lean RPC path doesn't read, so it degrades to the
    // live set here rather than hard-coding every coin visible.
    if (filter === "live" || filter === "final") coins = coins.filter((c) => !c.graduated);
    else if (filter === "graduated") coins = coins.filter((c) => c.graduated);
    total = coins.length;                 // total reflects the filtered set, so pagination is correct
    coins = coins.slice(offset, offset + limit); // and we still return just the requested page
  }
  return { source: "rpc", coins, total };
}

/// Platform-wide totals for a stats strip (indexer only; null without one).
export async function stats() {
  try { return await apiGet("/api/stats"); } catch { return null; }
}

/// Daily time-series (volume / launches / graduations) for the analytics page.
/// Indexer only; null without one — the page then falls back to demo series.
export async function series(days = 30) {
  try { return await apiGet(`/api/series?days=${days}`); } catch { return null; }
}

/// Recent trades for a coin (indexer only; empty without one — the chart still
/// comes from DexScreener regardless).
export async function recentTrades(token, limit = 50) {
  try { const { trades } = await apiGet(`/api/trades/${token}?limit=${limit}`); return trades; }
  catch { return []; }
}

/// Token metadata (name / symbol) for a card or the trade header.
export async function tokenMeta(token) {
  const t = new ethers.Contract(token, ABIS.erc20, _read);
  const [name, symbol] = await Promise.all([t.name().catch(() => "Token"), t.symbol().catch(() => "?")]);
  return { name, symbol };
}

// ── holders + trade/fee history — work with NO indexer (chain + explorer API) ─
const EXPLORER_API = CHAIN.explorer.replace(/\/+$/, "") + "/api/v2";
const _routerEvents = new ethers.Interface([
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut)",
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut)",
  "event FeeSplit(address indexed token, uint256 platform, uint256 deferred, uint256 platformCut, uint256 dev, uint256 floor, uint256 burn)",
]);
const _blkTs = new Map();
async function _tsOf(bn) {
  if (_blkTs.has(bn)) return _blkTs.get(bn);
  try { const b = await _read.getBlock(bn); const t = b ? Number(b.timestamp) : 0; _blkTs.set(bn, t); return t; } catch { return 0; }
}
// Router logs over a range — one call if the RPC allows it, else chunked so a
// range cap never breaks the read.
async function _routerLogs(topics, { lookback = 400000, chunk = 50000 } = {}) {
  const head = await _read.getBlockNumber();
  const start = Math.max(0, head - lookback);
  try { return await _read.getLogs({ address: CONTRACTS.padRouter, fromBlock: start, toBlock: head, topics }); }
  catch {}
  const out = [];
  for (let lo = start; lo <= head; lo += chunk) {
    const hi = Math.min(lo + chunk - 1, head);
    try { out.push(...await _read.getLogs({ address: CONTRACTS.padRouter, fromBlock: lo, toBlock: hi, topics })); } catch {}
  }
  return out;
}

/// Holders + count, from the chain explorer's public API (no indexer needed).
export async function holders(token, top = 12) {
  const base = `${EXPLORER_API}/tokens/${token}`;
  const [c, l] = await Promise.allSettled([
    fetch(`${base}/counters`).then((r) => (r.ok ? r.json() : null)),
    fetch(`${base}/holders`).then((r) => (r.ok ? r.json() : null)),
  ]);
  const count = c.status === "fulfilled" && c.value ? Number(c.value.token_holders_count) : null;
  const items = l.status === "fulfilled" && l.value ? l.value.items || [] : [];
  const supplyWei = Number(TOTAL_SUPPLY) * 1e18; // 1B * 1e18
  const list = items.slice(0, top).map((it) => ({
    address: (it.address?.hash || "").toLowerCase(),
    isContract: !!it.address?.is_contract,
    name: it.address?.name || null,
    pct: supplyWei > 0 ? (Number(it.value || 0) / supplyWei) * 100 : 0,
  }));
  return { count: Number.isFinite(count) ? count : null, top: list };
}

/// Recent trades straight from chain (fallback when the indexer isn't running).
export async function chainTrades(token, { limit = 30, lookback = 400000 } = {}) {
  try {
    const b = _routerEvents.getEvent("Bought").topicHash, s = _routerEvents.getEvent("Sold").topicHash;
    const tok = ethers.zeroPadValue(token.toLowerCase(), 32);
    const logs = await _routerLogs([[b, s], tok], { lookback });
    const rows = logs.map((l) => {
      const p = _routerEvents.parseLog(l); const buy = p.name === "Bought";
      return {
        side: buy ? "buy" : "sell", actor: (buy ? p.args.buyer : p.args.seller).toLowerCase(),
        eth: (buy ? p.args.ethIn : p.args.ethOut).toString(),
        tokens: (buy ? p.args.tokensOut : p.args.tokensIn).toString(),
        block: l.blockNumber, tx: l.transactionHash,
      };
    }).sort((a, z) => z.block - a.block).slice(0, limit);
    await Promise.all([...new Set(rows.map((r) => r.block))].map(async (bn) => {
      const t = await _tsOf(bn); rows.forEach((r) => { if (r.block === bn) r.ts = t; });
    }));
    return rows;
  } catch { return []; }
}

/// Best-available trades: the indexer API first (fast, complete), else chain.
export async function trades(token, limit = 30) {
  if (hasApi()) { const t = await recentTrades(token, limit); if (t.length) return t; }
  return chainTrades(token, { limit });
}

/// Lifetime fee totals for a coin (dev/platform/floor/burn), summed from chain.
export async function feeTotals(token) {
  try {
    const fs = _routerEvents.getEvent("FeeSplit").topicHash;
    const tok = ethers.zeroPadValue(token.toLowerCase(), 32);
    const logs = await _routerLogs([fs, tok], {});
    let platform = 0n, dev = 0n, floor = 0n, burn = 0n;
    for (const l of logs) {
      const p = _routerEvents.parseLog(l);
      platform += p.args.platform + p.args.deferred + p.args.platformCut;
      dev += p.args.dev; floor += p.args.floor; burn += p.args.burn;
    }
    return { platform, dev, floor, burn };
  } catch { return null; }
}

// ── reward engine (the 0.25% trader + 0.25% holder legs) ────────────────────
// The chain custodies the ETH and caps it; the indexer computes each wallet's
// exact net-volume (traders) and balance-seconds (holders) per epoch and serves
// the Merkle proofs. So the browser READS claimable rewards from the indexer API
// and SPENDS a plain RewardVault.claim() per leaf (user pays their own gas).

/// Everything a wallet can claim + what's still accruing this epoch.
/// Shape: { epoch, epochEndsIn, claimWindowH, claimable:[{coin,name,sym,side,epoch,eth,amount,proof}],
///          pending:[{sym,name,side,eth}], totals:{...} }. Empty (not thrown) when no indexer is set.
export async function rewards(addr) {
  const who = addr || _account;
  if (!who) return { claimable: [], pending: [], totals: {} };
  try { return await apiGet(`/api/rewards/${who}`); }
  catch { return { claimable: [], pending: [], totals: {} }; }
}

/// Protocol-wide reward totals for the page header (indexer only; {} without one).
export async function rewardStats() {
  try { return await apiGet(`/api/rewards/stats`); } catch { return {}; }
}

/// Claim ONE reward leaf. `c` is a row from rewards().claimable — it carries the
/// epoch, coin, side (0=Traders,1=Holders), amount (wei) and Merkle proof the
/// indexer served. A pure verify + capped ETH transfer on-chain; the user signs
/// one clean tx and keeps the ETH.
export async function claimReward(c) {
  requireRewardVault();
  if (!_signer) await connect();
  const vault = new ethers.Contract(CONTRACTS.rewardVault, ABIS.rewardVault, _signer);
  return guardedSend(vault, "claim", [c.epoch, c.coin, c.side, c.amount, c.proof], 0n, "Claim reward");
}

/// Claim EVERY available leaf. Sends them sequentially (one signature each) —
/// swap for a multicall once the vault ships one. Returns the count claimed.
export async function claimAllRewards(list) {
  requireRewardVault();
  const rows = list || (await rewards(_account)).claimable || [];
  let n = 0;
  for (const c of rows) { await claimReward(c); n++; }
  return n;
}

function requireRewardVault() {
  if (!isDeployed("rewardVault"))
    throw new Error("Rewards open when the Pad goes live — the vault isn't set yet (pre-deploy audit).");
}

/// Does this arbitrary token have a WETH Uniswap v3 pool on the chain? Checks the standard fee tiers so
/// the "open a position on any token" page can validate a pasted address. Optimistic-true if no factory
/// is configured (the deposit itself reverts if there's truly no pool).
const _V3FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
export async function hasLpPool(token) {
  const fAddr = CONTRACTS.v3Factory, weth = CONTRACTS.weth;
  if (!/^0x[0-9a-fA-F]{40}$/.test(fAddr || "") || !/^0x[0-9a-fA-F]{40}$/.test(weth || "")) return true;
  const f = new ethers.Contract(fAddr, _V3FACTORY_ABI, _read);
  for (const fee of [10000, 3000, 500, 100]) {
    try { const p = await f.getPool(token, weth, fee); if (p && !/^0x0+$/.test(p)) return true; } catch {}
  }
  return false;
}

// ── community floor vault (FloorCoop): add to the buy-wall, earn dip-buy fees ──
async function coopFor(token) {
  const f = new ethers.Contract(CONTRACTS.floorCoopFactory, ABIS.floorCoopFactory, _read);
  let coop = await f.coopOf(token);
  return coop; // 0x0 if none yet
}

/// Vault stats for the coin page: pool size, fees paid, and (if `who` set) their stake + claimable.
export async function floorInfo(token, who) {
  if (!isDeployed("floorCoopFactory")) return null;
  const coop = await coopFor(token);
  if (!coop || /^0x0+$/.test(coop)) return { tvlEth: 0, feesPaidEth: 0, mineEth: 0, earnedEth: 0, coop: null };
  const c = new ethers.Contract(coop, ABIS.floorCoop, _read);
  // NAV (band position + loose principal, valued at TWAP) — most of the vault's WETH lives in the
  // pool band, not the contract's loose balance, so read totalNav() rather than balanceOf(WETH).
  const [ts, nav] = await Promise.all([c.totalShares(), c.totalNav().catch(() => 0n)]);
  const out = { coop, tvlEth: Number(ethers.formatEther(nav)), feesPaidEth: 0, mineEth: 0, earnedEth: 0 };
  if (who && ts > 0n) {
    const [sh, pend, p] = await Promise.all([c.shares(who), c.pending(who), c.pos(who).catch(() => null)]);
    out.mineEth = Number(ethers.formatEther((nav * sh) / ts));
    out.earnedEth = Number(ethers.formatEther(pend[0]));
    // Per-user lock: lockUntil is a unix ts, or ~uint256.max for a "forever" lock. Surface both
    // the raw timestamp and derived flags so the UI can label a locked position honestly (and
    // warn about the 15% early-exit penalty) instead of always showing "unlocked".
    const luRaw = p ? (p.lockUntil ?? p[3] ?? 0n) : 0n;
    const forever = BigInt(luRaw) > 10n ** 18n; // any lock past year ~3e10 is the forever sentinel
    out.forever = forever;
    out.lockUntil = forever ? Infinity : Number(luRaw);
    out.unlocked = !forever && out.lockUntil > 0 && Math.floor(Date.now() / 1000) >= out.lockUntil;
  }
  return out;
}

/// Stake ETH into a coin's real liquidity, locked for `lockDays` (0 = forever). Creates the vault on
/// first use. The lock term feeds the reward-weight tier; early exit costs a 15% penalty on-chain.
export async function floorDeposit(token, ethAmount, lockDays = 90) {
  requireFloor();
  if (!_signer) await connect();
  const fac = new ethers.Contract(CONTRACTS.floorCoopFactory, ABIS.floorCoopFactory, _signer);
  let coop = await fac.coopOf(token);
  if (/^0x0+$/.test(coop)) { await (await guardedSend(fac, "createCoop", [token], 0n, "Create vault")).wait(); coop = await fac.coopOf(token); } // legacy + gas-clamped (heavy deploy; no 1559 on this chain)
  const c = new ethers.Contract(coop, ABIS.floorCoop, _signer);
  // (lockDays, minSharesOut=0): TWAP-guarded on-chain; UI can tighten minShares from a NAV quote later.
  return guardedSend(c, "deposit", [lockDays, 0n], ethers.parseEther(String(ethAmount)), "Lock liquidity");
}

export async function floorClaim(token) {
  requireFloor();
  if (!_signer) await connect();
  const coop = await coopFor(token);
  return guardedSend(new ethers.Contract(coop, ABIS.floorCoop, _signer), "claim", [], 0n, "Claim floor fees");
}

/// Withdraw the caller's whole stake (after the cooldown).
export async function floorWithdraw(token) {
  requireFloor();
  if (!_signer) await connect();
  const coop = await coopFor(token);
  const c = new ethers.Contract(coop, ABIS.floorCoop, _signer);
  const sh = await c.shares(_account);
  // minWethOut/minTokenOut=0 for now (TWAP-guarded on-chain); UI can tighten from a quote later.
  return guardedSend(c, "withdraw", [sh, 0n, 0n], 0n, "Withdraw from floor");
}

function requireFloor() {
  if (!isDeployed("floorCoopFactory"))
    throw new Error("The community floor opens when the Pad goes live (pre-deploy audit).");
}

// Restore an existing wallet session WITHOUT a popup (eth_accounts is silent), so the
// connection persists across page navigations instead of forcing a reconnect every page.
async function eagerConnect() {
  try {
    const eip = injected();
    if (!eip) return;
    const accts = await eip.request({ method: "eth_accounts" }); // silent: returns [] if not authorized
    if (!accts || !accts.length) return;
    _provider = new ethers.BrowserProvider(eip, "any");
    _signer = await _provider.getSigner();
    _account = await _signer.getAddress();
    eip.removeAllListeners?.("accountsChanged");
    eip.on?.("accountsChanged", () => location.reload());
    eip.on?.("chainChanged", () => location.reload());
    window.dispatchEvent(new Event("robinpad:ready"));   // re-fire so the UI shows the restored address
    window.dispatchEvent(new Event("sheriffpad:ready"));
  } catch { /* stays disconnected — the Connect button still works */ }
}

// expose a tiny global for the plain-HTML pages (no bundler)
if (typeof window !== "undefined") {
  window.RobinPad = {
    connect, account, short, linkTelegram, launch, launchedTokenOf, buy, sell, getTax,
    setCoinProfile, getCoinProfile, profileMessage,
    estimateDevBuyEth, isDeployed, tokenBalance, holdings, coinHolders,
    curveInfo, devEscrow, graduate, withdrawDev, burnDev, listCoins, tokenMeta,
    feed, stats, recentTrades, hasApi, coin,
    holders, trades, chainTrades, feeTotals,
    rewards, rewardStats, claimReward, claimAllRewards,
    floorInfo, floorDeposit, floorClaim, floorWithdraw,
  };
  window.SheriffPad = window.RobinPad; // back-compat alias for existing pages
  window.dispatchEvent(new Event("robinpad:ready"));
  window.dispatchEvent(new Event("sheriffpad:ready"));
  eagerConnect(); // silently restore a prior connection so it survives navigation
}
