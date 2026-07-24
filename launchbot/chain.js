// ─────────────────────────────────────────────────────────────────────────────
// Chain helpers — launch, buy, sell, balances
//
// Robinhood Chain has NO EIP-1559, so EVERY write must be a legacy (type-0) tx
// with an explicit gasPrice, or the node rejects it with -32601. `legacyOv()`
// builds those overrides and a launch also gets a gasLimit clamped under the
// chain's 2^24 per-tx cap.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from 'ethers';
import { CFG, CHAIN, ADDRESSES, ABI, DEFAULT_TAX } from './config.js';

export const provider = new ethers.JsonRpcProvider(CFG.rpc, {
  chainId: CHAIN.id, name: 'robinhood',
}, { staticNetwork: true });

const iface = { factory: new ethers.Interface(ABI.factory) };

/** Current legacy gas price, guarded against a null from the RPC. */
export async function gasPriceNow() {
  const fee = await provider.getFeeData();
  if (fee.gasPrice == null) throw new Error('RPC returned no gasPrice (a legacy chain must supply one)');
  return fee.gasPrice;
}

/** Legacy tx overrides (type-0 + explicit gasPrice). Robinhood Chain has no 1559. */
export async function legacyOv(extra = {}) {
  return { type: 0, gasPrice: await gasPriceNow(), ...extra };
}

export function factoryWith(signer) { return new ethers.Contract(ADDRESSES.factory, ABI.factory, signer); }
export function routerWith(signer) { return new ethers.Contract(ADDRESSES.router, ABI.router, signer); }
export const routerRead = new ethers.Contract(ADDRESSES.router, ABI.router, provider);
export function erc20(addr, runner = provider) { return new ethers.Contract(addr, ABI.erc20, runner); }

export async function ethBalance(addr) { return provider.getBalance(addr); }

/**
 * Launch a token from `signer`'s wallet. Optional dev buy via `devBuyWei`.
 * Returns { hash, token, curve, pool, devBought }.
 */
export async function launch(signer, { name, symbol, devBuyWei = 0n }) {
  const factory = factoryWith(signer);
  const params = {
    name, symbol,
    dev: await signer.getAddress(),
    tax: {
      buyBps: DEFAULT_TAX.buyBps, sellBps: DEFAULT_TAX.sellBps,
      walletBps: DEFAULT_TAX.walletBps, floorBps: DEFAULT_TAX.floorBps, burnBps: DEFAULT_TAX.burnBps,
      projectWallet: DEFAULT_TAX.projectWallet,
    },
  };
  const value = BigInt(devBuyWei);
  // Estimate gas, add 20% headroom, clamp under the 2^24 per-tx cap.
  let gasLimit;
  try {
    const est = await factory.launch.estimateGas(params, { value });
    gasLimit = (est * 12n) / 10n;
  } catch { gasLimit = BigInt(CHAIN.perTxGasCap) - 1n; } // estimate hiccup → give it headroom (unused gas is refunded)
  if (gasLimit > BigInt(CHAIN.perTxGasCap)) gasLimit = BigInt(CHAIN.perTxGasCap) - 1n;

  const ov = await legacyOv({ value, gasLimit });
  const tx = await factory.launch(params, ov);
  const rc = await tx.wait();

  // Parse the Launched event for the deterministic addresses.
  let token, curve, pool, devBought = 0n;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== ADDRESSES.factory.toLowerCase()) continue;
    try {
      const p = iface.factory.parseLog(log);
      if (p && p.name === 'Launched') {
        token = p.args.token; curve = p.args.curve; pool = p.args.pool; devBought = p.args.devBought;
        break;
      }
    } catch { /* not ours */ }
  }
  return { hash: tx.hash, token, curve, pool, devBought };
}

/** Buy `token` with `ethWei` from `signer`. minOut is derived with slippage. */
export async function buy(signer, token, ethWei) {
  const router = routerWith(signer);
  const value = BigInt(ethWei);
  // Quote first. If the simulation reverts, the real tx would revert too — abort
  // with a clear message instead of sending a trade with ZERO slippage protection.
  let minOut;
  try {
    const quoted = await router.buy.staticCall(token, 0n, { value });
    minOut = withSlippage(quoted);
  } catch {
    throw new Error("couldn't price this buy — the token may be in its anti-snipe window or illiquid. Try a smaller amount or wait a minute.");
  }
  const ov = await legacyOv({ value });
  const tx = await router.buy(token, minOut, ov);
  const rc = await tx.wait();
  return { hash: tx.hash, receipt: rc };
}

/** Sell `amountWei` of `token` from `signer`. Approves the router if needed. */
export async function sell(signer, token, amountWei) {
  const amount = BigInt(amountWei);
  const owner = await signer.getAddress();
  const t = erc20(token, signer);
  const allowance = await t.allowance(owner, ADDRESSES.router);
  if (allowance < amount) {
    const ov = await legacyOv();
    const atx = await t.approve(ADDRESSES.router, ethers.MaxUint256, ov);
    await atx.wait();
  }
  const router = routerWith(signer);
  let minOutEth;
  try {
    const quoted = await router.sell.staticCall(token, amount, 0n);
    minOutEth = withSlippage(quoted);
  } catch {
    throw new Error("couldn't price this sell — the token may be illiquid or paused. Try a smaller amount.");
  }
  const ov = await legacyOv();
  const tx = await router.sell(token, amount, minOutEth, ov);
  const rc = await tx.wait();
  return { hash: tx.hash, receipt: rc };
}

/** Sweep the ENTIRE ETH balance to `to` (minus gas). Returns { hash, sent } or null. */
export async function withdrawAll(signer, to) {
  const from = await signer.getAddress();
  const bal = await provider.getBalance(from);
  const gasPrice = await gasPriceNow();
  const gasLimit = 21000n;
  const cost = gasPrice * gasLimit;
  if (bal <= cost) return null; // nothing to sweep after gas
  const value = bal - cost;
  const tx = await signer.sendTransaction({ to, value, type: 0, gasPrice, gasLimit });
  await tx.wait();
  return { hash: tx.hash, sent: value };
}

function withSlippage(amount) {
  const bps = BigInt(Math.round((100 - CFG.slippagePct) * 100)); // e.g. 88% -> 8800
  return (BigInt(amount) * bps) / 10000n;
}
