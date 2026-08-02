// Unit tests for the Multicall3 read-batcher decode path.
//
// No network: a mock provider returns a hand-encoded aggregate3 result, and we assert mc3()
// decodes each entry, maps per-call failures (allowFailure) to null, and swallows decode
// mismatches. Live batched==direct correctness is validated separately against the chain.
//
//   node --test test/multicall.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { mc3, MULTICALL3 } from "../src/multicall.js";

const ercI = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
// Same shape multicall.js uses, to hand-build a fake aggregate3 return.
const MC3 = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
]);
const A = "0x000000000000000000000000000000000000dEaD";

// A provider whose call() ignores the request and returns a fixed encoded result set.
const providerReturning = (results) => ({
  call: async () => MC3.encodeFunctionResult("aggregate3", [results]),
});

test("decodes successes, maps failure + decode-mismatch to null", async () => {
  const okData = ercI.encodeFunctionResult("balanceOf", [123n]);
  const provider = providerReturning([
    { success: true, returnData: okData },   // clean uint256
    { success: false, returnData: "0x" },    // per-call revert (allowFailure)
    { success: true, returnData: "0x1234" }, // success but undecodable as uint256
  ]);
  const calls = [0, 1, 2].map(() => ({ target: A, iface: ercI, fn: "balanceOf", args: [A] }));
  const res = await mc3(provider, calls);
  assert.equal(res.length, 3);
  assert.equal(res[0][0], 123n, "decodes the good balance");
  assert.equal(res[1], null, "reverted call -> null");
  assert.equal(res[2], null, "undecodable returnData -> null");
});

test("empty calls -> [] and no provider hit", async () => {
  let hit = false;
  const provider = { call: async () => { hit = true; return "0x"; } };
  const res = await mc3(provider, []);
  assert.deepEqual(res, []);
  assert.equal(hit, false, "does not call the provider for an empty batch");
});

test("exports the canonical Multicall3 address", () => {
  assert.equal(MULTICALL3, "0xcA11bde05977b3631167028862bE2a173976CA11");
});
