// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — pad-v4 (no-pool-forever) ARC TESTER DEVNET wallet + read layer.
//
// Sibling of wallet-v4-local.js (Robinhood Chain) — identical shape, points at
// config-v4-arc-local.js instead. Not parameterized on purpose, matching this repo's convention
// of one small file per chain/environment rather than a shared abstraction (see deploy-local-demo.js
// vs deploy-arc-demo.js, deploy-curve.js vs deploy-curve-arc.js).
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "../assets/ethers.min.js";
import { CHAIN, ABIS, loadDeployment, MIN_SQRT_LIMIT, MAX_SQRT_LIMIT } from "./config-v4-arc-local.js";

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

/// Price in native-USDC per whole token, from a v4 sqrtPriceX96 (currency0=native, currency1=token).
export function usdcPerToken(sqrtPriceX96) {
  const Q96 = 2n ** 96n;
  const num = sqrtPriceX96 * sqrtPriceX96;
  const den = Q96 * Q96;
  const tokenPerUsdc = Number(num) / Number(den);
  return tokenPerUsdc > 0 ? 1 / tokenPerUsdc : 0;
}

export async function balanceOf(tokenAddr, who) {
  const tok = new ethers.Contract(tokenAddr, ABIS.erc20, _read);
  return tok.balanceOf(who);
}

/// Native-currency balance (USDC on Arc — the 18-decimal native interface, same mechanics as an
/// ETH balance elsewhere).
export async function nativeBalanceOf(who) {
  return _read.getBalance(who);
}

// ── writes (need a connected signer) ─────────────────────────────────────────

function requireSigner() {
  if (!_signer) throw new Error("Connect a wallet first.");
  return _signer;
}

/// Buy `nativeIn` (a decimal string, e.g. "1500") native-USDC worth of `pad.token` off its curve,
/// via PoolSwapTest.
export async function buy(pad, nativeIn) {
  const signer = requireSigner();
  const d = await loadDeployment();
  const sw = new ethers.Contract(d.contracts.poolSwapTest, ABIS.poolSwapTest, signer);
  const key = { currency0: ethers.ZeroAddress, currency1: pad.token, fee: 10000, tickSpacing: 100, hooks: pad.hook };
  const value = ethers.parseEther(String(nativeIn));
  const tx = await sw.swap(
    key,
    { zeroForOne: true, amountSpecified: -value, sqrtPriceLimitX96: MIN_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false },
    "0x",
    { value }
  );
  return tx.wait();
}

/// Sell `amountWei` (bigint, base units) of `pad.token` back into the curve via PoolSwapTest.
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
