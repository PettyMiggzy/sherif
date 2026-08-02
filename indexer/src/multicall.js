// Multicall3 read-batching — collapse many INDEPENDENT view calls into ONE eth_call.
//
// Multicall3 is deployed at the canonical address on Robinhood Chain (chainId 4663). Its
// aggregate3 runs every subcall inside a single block context, so the whole batch is
// block-consistent (an improvement over Promise.all, which can straddle blocks), and each
// subcall carries allowFailure:true so one bad or non-standard target can't revert the batch.
//
// READ-ONLY: this only ever issues eth_call. No transaction / write path uses it.
import { ethers } from "ethers";

// Canonical Multicall3 (same address on nearly every EVM chain; verified deployed on 4663).
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MC3_IFACE = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
]);

// Batch independent view calls into one eth_call.
//   provider: an ethers v6 provider (JsonRpcProvider / FallbackProvider).
//   calls:    [{ target, iface, fn, args }] — iface is an ethers.Interface, fn the function
//             name, args its arguments.
// Returns an array aligned to `calls`: the decoded ethers Result on success, or null on a
// per-call failure / decode mismatch. Throws ONLY if the whole eth_call fails, so callers
// should wrap in try/catch and fall back to per-call reads (batching can then only ever help).
const MC3_MAX = 50; // cap subcalls per eth_call so a big batch can't exhaust a node's call-gas and
                    // silently starve the tail; each chunk is still one upstream call.
export async function mc3(provider, calls) {
  if (!calls || !calls.length) return [];
  if (calls.length > MC3_MAX) {
    const out = [];
    for (let i = 0; i < calls.length; i += MC3_MAX) out.push(...(await mc3(provider, calls.slice(i, i + MC3_MAX))));
    return out;
  }
  const packed = calls.map((c) => ({
    target: c.target,
    allowFailure: true,
    callData: c.iface.encodeFunctionData(c.fn, c.args || []),
  }));
  const data = MC3_IFACE.encodeFunctionData("aggregate3", [packed]);
  const raw = await provider.call({ to: MULTICALL3, data });
  const [results] = MC3_IFACE.decodeFunctionResult("aggregate3", raw);
  return results.map((r, i) => {
    if (!r.success || !r.returnData || r.returnData === "0x") return null;
    try { return calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData); } catch { return null; }
  });
}
