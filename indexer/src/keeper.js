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
import { openOrders, cancelOrder } from "./orders.js";

const ABI = [
  "function execute((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o, bytes signature) returns (uint256)",
  "function cancelled(bytes32) view returns (bool)",
  "function hashOrder((address maker,address sellToken,address buyToken,uint256 sliceIn,uint256 minOut,uint256 slices,uint256 interval,uint256 expiry,uint256 salt) o) view returns (bytes32)",
];

const KEY = process.env.KEEPER_KEY || "";
const POLL_MS = Number(process.env.KEEPER_POLL_MS || 30000);
const GAS_CAP = BigInt(process.env.KEEPER_GAS_CAP || 3_000_000);

// Turn a stored order (string fields) into the tuple the contract expects.
function tuple(o) {
  return [o.maker, o.sellToken, o.buyToken, o.sliceIn, o.minOut, o.slices, o.interval, o.expiry, o.salt];
}

async function tick(contract, provider) {
  const now = Math.floor(Date.now() / 1000);
  const orders = openOrders(now);
  if (!orders.length) return;
  // Robinhood Chain has no EIP-1559, so every tx is legacy (type-0) with an explicit gasPrice.
  let gasPrice;
  try { gasPrice = (await provider.getFeeData()).gasPrice; } catch { gasPrice = ethers.parseUnits("0.1", "gwei"); }

  for (const { order, signature, hash } of orders) {
    const t = tuple(order);
    try {
      // Is it fillable right now? The contract reverts if not (price/cadence/filled/expired).
      await contract.execute.staticCall(t, signature);
    } catch (e) {
      // If the maker cancelled on-chain, drop it from the store so we stop probing it.
      try { if (await contract.cancelled(hash)) cancelOrder(hash); } catch { /* ignore */ }
      continue; // not fillable this round
    }
    try {
      let gas = GAS_CAP;
      try { gas = (await contract.execute.estimateGas(t, signature)) * 12n / 10n; } catch {}
      if (gas > GAS_CAP) gas = GAS_CAP;
      const txn = await contract.execute(t, signature, { type: 0, gasPrice, gasLimit: gas });
      const rc = await txn.wait();
      console.log(`[keeper] filled ${hash.slice(0, 10)} slice — tx ${rc.hash}`);
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
  console.log(`[keeper] running as ${wallet.address}, polling every ${POLL_MS}ms`);
  // Simple loop; a fill's own wait() paces us, and tick() is re-entrant-safe (each order is independent).
  for (;;) {
    try { await tick(contract, provider); } catch (e) { console.log("[keeper] tick error:", (e && e.message) || e); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Allow `node src/keeper.js` to run it directly.
if (import.meta.url === `file://${process.argv[1]}`) runKeeper();
