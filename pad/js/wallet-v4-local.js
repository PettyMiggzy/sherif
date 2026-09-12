// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — pad-v4 (no-pool-forever) LOCAL DEVNET wallet + read layer.
//
// Mirrors the shape of assets/wallet.js (connect/ensureChain/guardedSend) but stripped down for a
// local Hardhat devnet: no WalletConnect, no honeypot gate, no legacy-tx gas quirks (the local node
// supports EIP-1559 fine). Buys/sells go through PoolSwapTest (the same contract the pad-v4 test
// suite itself uses to swap) since pad-v4 doesn't have its own production router yet — a known,
// documented gap, not a placeholder pretending to be final.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "../assets/ethers.min.js";
import { CHAIN, ABIS, loadDeployment, MIN_SQRT_LIMIT, MAX_SQRT_LIMIT } from "./config-v4-local.js";

let _eip = null;
let _provider = null;
let _signer = null;
let _account = null;

const _read = new ethers.JsonRpcProvider(CHAIN.rpc[0], CHAIN.id, { staticNetwork: true });

export const account = () => _account;
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const isConnected = () => !!_account;

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
          rpcUrls: CHAIN.walletRpcUrls, blockExplorerUrls: [],
        }],
      });
    } else throw e;
  }
}

/// Connect an injected EIP-1193 wallet (MetaMask etc.) and switch/add the local devnet chain.
/// Throws a plain Error with a readable message if no injected wallet exists — callers show it, not crash.
export async function connect() {
  const eip = window.ethereum;
  if (!eip) throw new Error("No wallet found. Install MetaMask (or any injected wallet) to use the local devnet.");
  await eip.request({ method: "eth_requestAccounts" });
  await ensureChain(eip);
  _eip = eip;
  _provider = new ethers.BrowserProvider(eip, "any");
  _signer = await _provider.getSigner();
  _account = await _signer.getAddress();
  eip.removeAllListeners?.("accountsChanged");
  eip.removeAllListeners?.("chainChanged");
  eip.on?.("accountsChanged", () => location.reload());
  eip.on?.("chainChanged", () => location.reload());
  return _account;
}

export function disconnect() {
  _eip?.removeAllListeners?.("accountsChanged");
  _eip?.removeAllListeners?.("chainChanged");
  _eip = null; _provider = null; _signer = null; _account = null;
}

// ── reads (work with or without a connected wallet) ─────────────────────────

export async function listPads() {
  const d = await loadDeployment();
  const factory = new ethers.Contract(d.contracts.curveFactory, ABIS.factory, _read);
  const stateView = new ethers.Contract(d.contracts.stateView, ABIS.stateView, _read);
  const out = [];
  for (const p of d.pads) {
    const tok = new ethers.Contract(p.token, ABIS.erc20, _read);
    const curve = new ethers.Contract(p.curve, ABIS.curve, _read);
    const [supply, slot0, ready, graduated] = await Promise.all([
      tok.totalSupply(),
      stateView.getSlot0(p.poolId),
      curve.ready(),
      curve.graduated(),
    ]);
    out.push({ ...p, totalSupply: supply, tick: Number(slot0[1]), sqrtPriceX96: slot0[0], ready, graduated });
  }
  return out;
}

/// Price in ETH per whole token, from a v4 sqrtPriceX96 (currency0=ETH, currency1=token — this repo's
/// convention throughout, see RobinCurveV4/CurvePadFactoryV4). price(token/eth) = (sqrtP/2^96)^2, so
/// ETH-per-token = 1/that.
export function ethPerToken(sqrtPriceX96) {
  const Q96 = 2n ** 96n;
  const num = sqrtPriceX96 * sqrtPriceX96; // token-per-eth numerator scaled by 2^192
  const den = Q96 * Q96;
  // tokenPerEth = num/den (a huge ratio); ethPerToken = den/num. Do it in floating point for display only.
  const tokenPerEth = Number(num) / Number(den);
  return tokenPerEth > 0 ? 1 / tokenPerEth : 0;
}

export async function balanceOf(tokenAddr, who) {
  const tok = new ethers.Contract(tokenAddr, ABIS.erc20, _read);
  return tok.balanceOf(who);
}

export async function ethBalanceOf(who) {
  return _read.getBalance(who);
}

// ── writes (need a connected signer) ─────────────────────────────────────────

function requireSigner() {
  if (!_signer) throw new Error("Connect a wallet first.");
  return _signer;
}

/// Buy `ethIn` (a decimal string, e.g. "0.1") of ETH worth of `pad.token` off its curve, via PoolSwapTest.
export async function buy(pad, ethIn) {
  const signer = requireSigner();
  const d = await loadDeployment();
  const sw = new ethers.Contract(d.contracts.poolSwapTest, ABIS.poolSwapTest, signer);
  const key = { currency0: ethers.ZeroAddress, currency1: pad.token, fee: 10000, tickSpacing: 100, hooks: pad.hook };
  const value = ethers.parseEther(String(ethIn));
  const tx = await sw.swap(
    key,
    { zeroForOne: true, amountSpecified: -value, sqrtPriceLimitX96: MIN_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false },
    "0x",
    { value }
  );
  return tx.wait();
}

/// Sell `amountWei` (bigint, base units) of `pad.token` back into the curve via PoolSwapTest. Needs a prior
/// approve — this does the approve itself if the current allowance is short, same convention as the live
/// site's wallet.js (one guarded approve, exact amount, never infinite).
export async function sell(pad, amountWei) {
  const signer = requireSigner();
  const d = await loadDeployment();
  const tok = new ethers.Contract(pad.token, ABIS.erc20, signer);
  const spender = d.contracts.poolSwapTest;
  const allowance = await tok.allowance(_account, spender);
  if (allowance < amountWei) {
    await (await tok.approve(spender, amountWei)).wait();
  }
  const sw = new ethers.Contract(spender, ABIS.poolSwapTest, signer);
  const key = { currency0: ethers.ZeroAddress, currency1: pad.token, fee: 10000, tickSpacing: 100, hooks: pad.hook };
  const tx = await sw.swap(
    key,
    { zeroForOne: false, amountSpecified: -amountWei, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false },
    "0x"
  );
  return tx.wait();
}
