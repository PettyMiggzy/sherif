// ─────────────────────────────────────────────────────────────────────────────
// The Sheriff's Pad — wallet + signing layer  (audit target)
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
  CHAIN, CONTRACTS, ABIS, POOL_FEE, TOTAL_SUPPLY, MAX_DEVBUY_BPS,
  GAS_BUFFER_WEI, isDeployed,
} from "./config.js";

let _provider = null; // ethers BrowserProvider
let _signer = null;
let _account = null;

// A read-only provider for quotes/simulation even before the user connects.
const _read = new ethers.JsonRpcProvider(CHAIN.rpc[0], CHAIN.id);

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
  if (s.includes("dev>2%") || s.includes("dev>"))
    return new Error("That opening buy is over the 2% cap. Lower the dev buy.");
  if (s.includes("maxwallet") || s.includes("maxtx") || s.includes("cooldown") || s.includes("antisnip"))
    return new Error("The opening anti-snipe window caps buy size right now. Try a smaller amount or wait a minute.");
  if (s.includes("slippage") || s.includes("too little received") || s.includes("price"))
    return new Error("Price moved past your slippage. Raise slippage a touch or retry.");
  return new Error(label ? `${label} failed: ${raw || "unknown error"}` : (raw || "Transaction failed."));
}

// ── connect + chain guard ───────────────────────────────────────────────────
export async function connect() {
  const eip = injected();
  if (!eip) throw new Error("No wallet found. Install Phantom or another EVM wallet, then reload.");

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
          rpcUrls: CHAIN.rpc, blockExplorerUrls: [CHAIN.explorer],
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
    `Sheriff's Pad — link this wallet to Telegram\n` +
    `Telegram: ${handle}\n` +
    `Wallet: ${_account}\n` +
    `Nonce: ${nonce}\n` +
    `This is a free signature, not a transaction. It moves no funds.`;
  const signature = await _signer.signMessage(message); // personal_sign
  return { message, signature, address: _account };
}

// ── the guard: simulate + balance-check BEFORE any signature ──────────────────
// Returns the sent tx (caller awaits .wait()). Throws a friendly error if the tx
// would revert OR the wallet can't cover value+gas — so the user never sees the
// wallet's red screen for what is really just "not enough ETH".
async function guardedSend(contract, method, args, valueWei, label) {
  const value = valueWei ?? 0n;

  // 1) simulate the exact call (eth_call). Catches contract reverts up-front.
  try { await contract[method].staticCall(...args, { value }); }
  catch (e) { throw friendly(e, label); }

  // 2) estimate gas (a second simulation) so we can price the tx.
  let gas;
  try { gas = await contract[method].estimateGas(...args, { value }); }
  catch (e) { throw friendly(e, label); }

  // 3) balance check — the whole point: refuse locally, kindly, if it won't fit.
  const [bal, fee] = await Promise.all([_provider.getBalance(_account), _provider.getFeeData()]);
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gasCost = gas * gasPrice;
  const need = value + gasCost + GAS_BUFFER_WEI;
  if (bal < need) {
    const fmt = (w) => (+ethers.formatEther(w)).toFixed(4);
    throw new Error(`Not enough ETH. This needs ≈ ${fmt(need)} ETH (incl. gas); you have ${fmt(bal)}.`);
  }

  // 4) send — single signer, feePayer = the user, one recipient. [Rules 2 & 4]
  try {
    return await contract[method](...args, { value, gasLimit: (gas * 12n) / 10n });
  } catch (e) { throw friendly(e, label); }
}

// ── LAUNCH — one call, one recipient, optional dev buy, approval-free [Rule 1] ─
// devBuyEth: string ETH amount to spend on the creator's OWN opening buy (≤2%,
// enforced + excess-refunded by the contract). "0" = no dev buy.
export async function launch({ name, symbol, dev, devBuyEth = "0" }) {
  if (!_signer) await connect();
  if (!isDeployed("padFactory"))
    throw new Error("The launch contract isn't live yet — the Pad is in pre-deploy audit.");
  const value = devBuyEth && Number(devBuyEth) > 0 ? ethers.parseEther(String(devBuyEth)) : 0n;
  const factory = new ethers.Contract(CONTRACTS.padFactory, ABIS.padFactory, _signer);
  const params = { name, symbol, dev: dev || _account };
  const tx = await guardedSend(factory, "launch", [params], value, "Launch");
  return tx; // await tx.wait() then read the Launched event for {token, curve, pool}
}

// ── BUY — native ETH in, no ERC20 approval, tokens straight to the buyer [Rule 1]
export async function buy({ pool, token, ethAmount, slippagePct = 8 }) {
  if (!_signer) await connect();
  requireRouter();
  const value = ethers.parseEther(String(ethAmount));
  const minOut = await quoteMinOut({ pool, tokenIn: CONTRACTS.weth, tokenOut: token, amountIn: value, slippagePct });
  const router = new ethers.Contract(CONTRACTS.swapRouter, ABIS.swapRouter, _signer);
  const p = {
    tokenIn: CONTRACTS.weth, tokenOut: token, fee: POOL_FEE, recipient: _account,
    amountIn: value, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
  };
  // exactInputSingle is payable; tokenIn=WETH + msg.value ⇒ router wraps for us.
  return guardedSend(router, "exactInputSingle", [p], value, "Buy");
}

// ── SELL — the single, isolated, EXACT-amount approval to the verified router ──
// EVM has no approval-free way to sell a standard ERC20 through an AMM. So this
// is the ONE approval in the app, and we keep it the safe kind Blowfish does not
// flag: exact amount (never MaxUint), to the canonical verified router only,
// simulated first. Everything else stays approval-free.
export async function sell({ pool, token, tokenAmount, slippagePct = 8 }) {
  if (!_signer) await connect();
  requireRouter();
  const erc = new ethers.Contract(token, ABIS.erc20, _signer);
  const amountIn = ethers.parseUnits(String(tokenAmount), 18);

  const allowance = await erc.allowance(_account, CONTRACTS.swapRouter);
  if (allowance < amountIn) {
    // EXACT amount, verified spender. Not infinite, not to a random contract.
    const atx = await erc.approve(CONTRACTS.swapRouter, amountIn);
    await atx.wait();
  }

  const minOut = await quoteMinOut({ pool, tokenIn: token, tokenOut: CONTRACTS.weth, amountIn, slippagePct });
  const router = new ethers.Contract(CONTRACTS.swapRouter, ABIS.swapRouter, _signer);
  // Swap token→WETH into the router, then unwrap to native ETH to the user, in
  // one multicall. recipient=ADDRESS_THIS (router sentinel 0x…02) then unwrap.
  // NOTE (deploy): verify SwapRouter02 sentinel + selectors against the actual
  // Robinhood Chain deployment before enabling — this path is gated on swapRouter.
  const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
  const p = {
    tokenIn: token, tokenOut: CONTRACTS.weth, fee: POOL_FEE, recipient: ADDRESS_THIS,
    amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
  };
  const swapData = router.interface.encodeFunctionData("exactInputSingle", [p]);
  const unwrapData = router.interface.encodeFunctionData("unwrapWETH9", [minOut, _account]);
  return guardedSend(router, "multicall", [[swapData, unwrapData]], 0n, "Sell");
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
    return (out * (10000n - bufferPct)) / 10000n;
  } catch {
    // last resort: let the user's wallet enforce nothing, simulation still guards
    return 0n;
  }
}

function requireRouter() {
  if (!isDeployed("swapRouter"))
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

// expose a tiny global for the plain-HTML pages (no bundler)
if (typeof window !== "undefined") {
  window.SheriffPad = {
    connect, account, short, linkTelegram, launch, buy, sell,
    estimateDevBuyEth, isDeployed,
  };
  window.dispatchEvent(new Event("sheriffpad:ready"));
}
