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
// [BRAND] The one `1ab5` miner, shared with the pad site, the SDK and the contract test suite. Imported
// rather than transcribed: the CREATE2 chain it walks is three keccaks deep and a wrong copy shows up only
// as a launch reverting BadTokenSuffix, with nothing pointing back at the arithmetic.
import { mineSalt } from './mine/robin-mine.mjs';

export let provider = new ethers.JsonRpcProvider(CFG.rpc, {
  chainId: CHAIN.id, name: 'robinhood',
}, { staticNetwork: true });

// READ-ONLY provider that prefers free/public RPCs to save the paid RPC's quota.
// When FREE_RPCS is set, reads go to a FallbackProvider that tries the free nodes
// first (priority 1) and only falls back to the paid RPC (priority 2) if they
// stall or fail — quorum 1, so one good answer suffices. A lying free node can
// only mis-report a read; it can NEVER sign or broadcast (writes use `provider`).
// When FREE_RPCS is empty, readProvider === provider (no behavior change).
export let readProvider = makeReadProvider();
function makeReadProvider() {
  if (!CFG.freeRpcs.length && !CFG.backupRpcs.length) return provider;
  try {
    const opts = { chainId: CHAIN.id, name: 'robinhood' };
    const subs = CFG.freeRpcs.map((url) => ({
      provider: new ethers.JsonRpcProvider(url, opts, { staticNetwork: true }),
      priority: 1, weight: 1, stallTimeout: 1500,
    }));
    subs.push({ provider, priority: 2, weight: 1, stallTimeout: 2000 }); // paid RPC = reliable backstop
    // BACKUP_RPCS: additional backstops at the same priority-2 tier as the paid RPC (used only if a
    // priority-1 read stalls/fails). NOT preferred like FREE_RPCS. Reads only; writes use `provider`.
    for (const url of CFG.backupRpcs) subs.push({
      provider: new ethers.JsonRpcProvider(url, opts, { staticNetwork: true }),
      priority: 2, weight: 1, stallTimeout: 2000,
    });
    return new ethers.FallbackProvider(subs, opts, { quorum: 1 });
  } catch { return provider; } // any construction issue → just use the paid RPC
}

// Test seam: swap in a mock provider for offline simulation. No effect in prod.
export function __setProviderForTests(p) { provider = p; readProvider = p; }

// Bound how long we wait for a tx to mine. ethers' tx.wait() has NO default
// timeout, so a stuck/underpriced tx would hang forever and (via the per-user
// lock) lock that user out until a restart. 3 minutes is plenty for this L2.
const WAIT_TIMEOUT_MS = 180_000;
function waitFor(tx) { return tx.wait(1, WAIT_TIMEOUT_MS); }

const iface = { factory: new ethers.Interface(ABI.factory) };

/** Current legacy gas price, guarded against a null from the RPC. */
export async function gasPriceNow() {
  const fee = await provider.getFeeData();
  if (fee.gasPrice == null) throw new Error('RPC returned no gasPrice (a legacy chain must supply one)');
  let gp = fee.gasPrice;
  // This chain has a MOVING base fee; getFeeData() can return a value a hair below it,
  // which the node rejects ("max fee per gas less than block base fee"). Floor at 1.2x
  // the latest base fee so a tick-up between quote and mining can't underprice the tx.
  try {
    const blk = await provider.getBlock('latest');
    const floor = ((blk?.baseFeePerGas ?? 0n) * 12n) / 10n;
    if (floor > gp) gp = floor;
  } catch { /* keep the suggested price if the block read fails */ }
  return gp;
}

/** Legacy tx overrides (type-0 + explicit gasPrice). Robinhood Chain has no 1559. */
export async function legacyOv(extra = {}) {
  return { type: 0, gasPrice: await gasPriceNow(), ...extra };
}

export function factoryWith(signer) { return new ethers.Contract(ADDRESSES.factory, ABI.factory, signer); }
export function routerWith(signer) { return new ethers.Contract(ADDRESSES.router, ABI.router, signer); }
export const routerRead = new ethers.Contract(ADDRESSES.router, ABI.router, provider);
export function erc20(addr, runner = provider) { return new ethers.Contract(addr, ABI.erc20, runner); }

// Balance reads are the bot's highest-frequency call (every /start, /balance,
// launch precheck) — route them through the free-RPC-preferring read provider.
export async function ethBalance(addr) { return readProvider.getBalance(addr); }

// STRICT balance from the PAID RPC only. Use this for any IRREVERSIBLE decision
// gated on balance (e.g. /forget deleting a custodial key): a lying/stale free
// node reporting 0 must never be able to trigger permanent key deletion while
// funds are on-chain. Reads/writes that the chain itself validates can use the
// cheaper ethBalance; this one cannot.
export async function ethBalanceStrict(addr) { return provider.getBalance(addr); }

/**
 * Launch a token from `signer`'s wallet. Optional dev buy via `devBuyWei`.
 * Returns { hash, token, curve, pool, devBought }.
 */
/// The CREATE2 context a `1ab5` mine needs: the deployer, the factory, and the init-code hash of the exact
/// coin being launched. `tokenDeployer` and `TOTAL_SUPPLY` never change for a given factory, so they are read
/// once and cached; the init-code hash depends on name/symbol and is read per launch.
let _mineBase = null;
async function mineContext(factory, creator, name, symbol) {
  if (!_mineBase) {
    const [tokenDeployer, supply] = await Promise.all([factory.tokenDeployer(), factory.TOTAL_SUPPLY()]);
    _mineBase = { tokenDeployer, supply };
  }
  const dep = new ethers.Contract(_mineBase.tokenDeployer, ABI.tokenDeployer, provider);
  return {
    tokenDeployer: _mineBase.tokenDeployer,
    factory: ADDRESSES.factory,
    creator,
    // Read from the deployer that will actually build the coin, never from bytecode bundled in this repo —
    // a bundled copy can drift from what is live and every launch would revert with no way to see why.
    initCodeHash: await dep.tokenInitCodeHash(name, symbol, _mineBase.supply, ADDRESSES.factory),
    supply: _mineBase.supply,
  };
}

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

  // [BRAND] Mine the coin's address before spending anything. ~65k keccak tries, a couple of seconds on the
  // bot host. The salt binds to `params.dev` (the wallet that will send the tx), so it is worthless to anyone
  // else and mining it for the wrong signer produces a salt the factory rejects.
  const ctx = await mineContext(factory, params.dev, name, symbol);
  const { salt } = mineSalt(ethers, ctx, ethers.id(`${symbol}-${name}-${params.dev}`));

  // Estimate gas, add 20% headroom, clamp under the 2^24 per-tx cap.
  let gasLimit;
  try {
    const est = await factory.launchWithSalt.estimateGas(params, salt, { value });
    gasLimit = (est * 12n) / 10n;
  } catch { gasLimit = BigInt(CHAIN.perTxGasCap) - 1n; } // estimate hiccup → give it headroom (unused gas is refunded)
  if (gasLimit >= BigInt(CHAIN.perTxGasCap)) gasLimit = BigInt(CHAIN.perTxGasCap) - 1n;

  const ov = await legacyOv({ value, gasLimit });
  const tx = await factory.launchWithSalt(params, salt, ov);
  const rc = await waitFor(tx);

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
  let quoted;
  try {
    quoted = await router.buy.staticCall(token, 0n, { value });
  } catch {
    throw new Error("couldn't price this buy — the token may be in its anti-snipe window or illiquid. Try a smaller amount or wait a minute.");
  }
  // A 0 (or dust) quote means the trade would net ~nothing — abort rather than
  // send a real tx with a 0 slippage floor (some curves return 0 vs reverting).
  if (quoted <= 0n) throw new Error("this buy would return ~0 tokens right now (anti-snipe window or too small) — try again shortly or with more ETH.");
  const minOut = withSlippage(quoted);
  const ov = await legacyOv({ value });
  const tx = await router.buy(token, minOut, ov);
  const rc = await waitFor(tx);
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
    await waitFor(atx);
  }
  const router = routerWith(signer);
  let quotedEth;
  try {
    quotedEth = await router.sell.staticCall(token, amount, 0n);
  } catch {
    throw new Error("couldn't price this sell — the token may be illiquid or paused. Try a smaller amount.");
  }
  if (quotedEth <= 0n) throw new Error("this sell would return ~0 ETH right now — the curve may be illiquid or paused. Try later.");
  const minOutEth = withSlippage(quotedEth);
  const ov = await legacyOv();
  const tx = await router.sell(token, amount, minOutEth, ov);
  const rc = await waitFor(tx);
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
  await waitFor(tx);
  return { hash: tx.hash, sent: value };
}

function withSlippage(amount) {
  const bps = BigInt(Math.round((100 - CFG.slippagePct) * 100)); // e.g. 88% -> 8800
  return (BigInt(amount) * bps) / 10000n;
}
