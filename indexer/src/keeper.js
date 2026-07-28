// ─────────────────────────────────────────────────────────────────────────────
// RobinLimit keeper — fills signed limit / DCA orders when they clear.
//
// Reads the open orders from the store, and for each one asks the chain "would this fill right
// now?" by static-calling execute(order, signature). The contract reverts unless every condition
// holds (price >= the maker's minOut, DCA cadence elapsed, not filled/expired/cancelled), so a
// successful static call IS the fill signal. When it passes, the keeper broadcasts the real tx
// and earns the capped keeper fee. It never holds user funds and can't move anything the maker
// didn't sign; a bad order just reverts and costs the keeper gas.
//
// OFF unless KEEPER_KEY and ROBIN_LIMIT are set. Run:  node src/keeper.js
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { openOrders, cancelOrder, setFilled, bumpAttempts } from "./orders.js";

const ABI = [
  "function execute((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o, bytes signature) returns (uint256)",
  "function cancelled(bytes32) view returns (bool)",
  "function filledSlices(bytes32) view returns (uint256)",
  "function keeperFeeBps() view returns (uint16)",
  "function hashOrder((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o) view returns (bytes32)",
];

const KEY = process.env.KEEPER_KEY || "";
const POLL_MS = Number(process.env.KEEPER_POLL_MS || 30000);
const GAS_CAP = BigInt(process.env.KEEPER_GAS_CAP || 3_000_000);
// Profitability guard: skip a fill unless its keeper fee (in ETH terms) covers gas with this margin,
// and skip dust slices below MIN_SLICE_WEI. Stops a griefer posting fillable-but-unprofitable dust
// orders that would drain the keeper's ETH on gas.
const MIN_SLICE_WEI = BigInt(process.env.KEEPER_MIN_SLICE_WEI || 2_000_000_000_000_000n); // 0.002 ETH-side
const PROFIT_MARGIN = BigInt(process.env.KEEPER_PROFIT_MARGIN || 2); // fee must exceed gas cost by this factor
const WETH_LC = (CFG.weth || "").toLowerCase();

// Turn a stored order (string fields) into the tuple the contract expects.
function tuple(o) {
  return [o.maker, o.sellToken, o.buyToken, o.sliceIn, o.minOut, o.slices, o.interval, o.expiry, o.salt];
}

// Legacy (type-0) gas price floored ABOVE the latest block's base fee, so a fill can't sit unmined
// on this moving-base-fee chain (mirrors the pad's own safeGasPrice).
async function legacyGasPrice(provider) {
  let gp = 0n, base = 0n;
  try { gp = (await provider.getFeeData()).gasPrice || 0n; } catch {}
  try { const b = await provider.getBlock("latest"); base = (b && b.baseFeePerGas) || 0n; } catch {}
  const floor = base > 0n ? (base * 12n) / 10n : ethers.parseUnits("0.1", "gwei");
  return gp > floor ? gp : floor;
}

async function tick(contract, provider, feeBps) {
  const now = Math.floor(Date.now() / 1000);
  const orders = openOrders(now);
  if (!orders.length) return;
  const gasPrice = await legacyGasPrice(provider);

  for (const { order, signature, hash } of orders) {
    const t = tuple(order);
    let makerOut;
    try {
      // Is it fillable right now? The contract reverts if not (price/cadence/filled/expired). The
      // return value is the maker's out — for a sell that's WETH we can value the fee against.
      makerOut = await contract.execute.staticCall(t, signature);
    } catch (e) {
      // Not fillable this round. Bump attempts so chronic junk sinks below fresh orders, and retire it
      // outright if it is cancelled on-chain OR fully filled (so it stops being re-probed).
      bumpAttempts(hash);
      try {
        if (await contract.cancelled(hash)) { cancelOrder(hash); continue; }
        const done = Number(await contract.filledSlices(hash));
        if (done > 0) setFilled(hash, done);
        if (done >= Number(order.slices)) cancelOrder(hash); // complete → drop from open
      } catch { /* ignore */ }
      continue;
    }

    // Profitability + dust guard. The keeper fee is `feeBps` of the output; value it in ETH terms —
    // for a buy the ETH side is the WETH spent (sliceIn), for a sell it's the WETH received (makerOut).
    const isBuy = order.sellToken.toLowerCase() === WETH_LC;
    const ethSide = isBuy ? BigInt(order.sliceIn) : BigInt(makerOut);
    let gas = GAS_CAP;
    try { gas = (await contract.execute.estimateGas(t, signature)) * 12n / 10n; } catch {}
    if (gas > GAS_CAP) gas = GAS_CAP;
    const feeEth = (ethSide * BigInt(feeBps)) / 10000n;
    if (ethSide < MIN_SLICE_WEI || feeEth < gas * gasPrice * PROFIT_MARGIN) {
      bumpAttempts(hash); // fillable but not worth the gas right now — deprioritize, don't burn ETH on it
      continue;
    }

    try {
      const txn = await contract.execute(t, signature, { type: 0, gasPrice, gasLimit: gas });
      const rc = await txn.wait(1, 120000); // bound the wait so a stuck tx can't hang the whole loop
      console.log(`[keeper] filled ${hash.slice(0, 10)} slice — tx ${rc.hash}`);
      // record progress so the order retires from the open set once every slice is done
      try { const done = Number(await contract.filledSlices(hash)); setFilled(hash, done); } catch {}
    } catch (e) {
      console.log(`[keeper] fill failed ${hash.slice(0, 10)}: ${(e && e.shortMessage) || (e && e.message) || e}`);
    }
  }
}

export async function runKeeper() {
  if (!KEY || !/^0x[0-9a-f]{40}$/.test(CFG.robinLimit)) {
    console.log("[keeper] disabled (set KEEPER_KEY and ROBIN_LIMIT to run)");
    return;
  }
  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(KEY, provider);
  const contract = new ethers.Contract(ethers.getAddress(CFG.robinLimit), ABI, wallet);
  let feeBps = 20;
  try { feeBps = Number(await contract.keeperFeeBps()); } catch {}
  console.log(`[keeper] running as ${wallet.address}, fee ${feeBps}bps, polling every ${POLL_MS}ms`);
  // Simple loop; a fill's own wait() paces us, and tick() is re-entrant-safe (each order is independent).
  for (;;) {
    try { await tick(contract, provider, feeBps); } catch (e) { console.log("[keeper] tick error:", (e && e.message) || e); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Allow `node src/keeper.js` to run it directly.
if (import.meta.url === `file://${process.argv[1]}`) runKeeper();
