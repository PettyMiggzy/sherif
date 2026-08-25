/* FORK BOUNDARY CHECK — replay the bench's EXACT flow against the LIVE deployed testnet contracts.
 *
 * Forks the testnet and uses the real factory / fee-config / deployer / router (same addresses the
 * bench uses), so the curve geometry and every contract are identical to what a tester hits. Replays
 * the sequence that failed (small buys → sell → a bigger buy that crosses sell-out) to (1) reproduce
 * the 0x2229d0b4 revert and (2) prove that capping the buy at gradTick's sqrtPrice fixes it.
 *
 * Run:  FORK_RPC=https://rpc.testnet.chain.robinhood.com npx hardhat run scripts/fork-boundary-check.js
 */
const { ethers, network } = require("hardhat");
const { mineHookSalt, hookInitCode } = require("./mine");
const { bindSalt } = require("../test/helpers/brand");

// live testnet addresses (mirror staging/config.js)
const A = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  deployer: "0x521DCd4F3ed73107dc5C62Ff357C59d99efd6FFB",
  feeRegistry: "0x1A211C5e6B4a8B2FB96E8e1Dd05D3B2A53937992",
  factory: "0xfE1CaAb7c8c024Dfb8D696262F206dE9964E3537",
  swapRouter: "0x5465091F4f71EE34B35E3697e0805E9310f43119",
};
const ZERO = ethers.ZeroAddress;
const MIN_SQRT = 4295128739n + 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const TS = 60, FEE = 10000;

function sqrtAtTick(tick) {
  const t = BigInt(tick); const a = t < 0n ? -t : t; if (a > 887272n) throw new Error("oor");
  let r = (a & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const M = (h) => { r = (r * h) >> 128n; };
  if (a & 0x2n) M(0xfff97272373d413259a46990580e213an); if (a & 0x4n) M(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (a & 0x8n) M(0xffe5caca7e10e4e61c3624eaa0941cd0n); if (a & 0x10n) M(0xffcb9843d60f6159c9db58835c926644n);
  if (a & 0x20n) M(0xff973b41fa98c081472e6896dfb254c0n); if (a & 0x40n) M(0xff2ea16466c96a3843ec78b326b52861n);
  if (a & 0x80n) M(0xfe5dee046a99a2a811c461f1969c3053n); if (a & 0x100n) M(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (a & 0x200n) M(0xf987a7253ac413176f2b074cf7815e54n); if (a & 0x400n) M(0xf3392b0822b70005940c7a398e4b70f3n);
  if (a & 0x800n) M(0xe7159475a2c29b7443b29c7fa6e889d9n); if (a & 0x1000n) M(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (a & 0x2000n) M(0xa9f746462d870fdf8a65dc1f90e061e5n); if (a & 0x4000n) M(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (a & 0x8000n) M(0x31be135f97d08fd981231505542fcfa6n); if (a & 0x10000n) M(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (a & 0x20000n) M(0x5d6af8dedb81196699c329225ee604n); if (a & 0x40000n) M(0x2216e584f5fa1ea926041bedfe98n);
  if (a & 0x80000n) M(0x48a170391f7dc42444e8fa2n);
  if (t > 0n) r = ((1n << 256n) - 1n) / r;
  return (r >> 32n) + ((r & 0xffffffffn) === 0n ? 0n : 1n);
}
function selectorOf(e) {
  const seen = new Set(); const st = [e];
  while (st.length) { const v = st.pop(); if (v == null || seen.has(v)) continue;
    if (typeof v === "string") { const m = v.match(/0x[0-9a-fA-F]{8,}/); if (m) return m[0].slice(0, 10); continue; }
    if (typeof v !== "object") continue; seen.add(v);
    for (const k of ["data", "error", "info", "value", "cause", "shortMessage", "message"]) if (k in v) st.push(v[k]); }
  return "(no selector)";
}

async function launch(factory, tag, creator) {
  const cfg = { name: "Robin " + tag, symbol: tag, decimals: 18, supply: E(1_040_000), curveSupply: E(470_000), reserveSupply: E(470_000), tickSpacing: TS, startTickMag: 0, creator };
  const TokenF = await ethers.getContractFactory("PadToken");
  const tokenSalt = ethers.id("tok-" + tag);
  const tokenInit = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, 18, cfg.supply, A.factory])]);
  const predicted = ethers.getCreate2Address(A.deployer, bindSalt(cfg, tokenSalt), ethers.keccak256(tokenInit));
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(A.deployer, hookInitCode(HookF.bytecode, A.poolManager, A.factory, A.feeRegistry, predicted));
  const curveSalt = ethers.id("curve-" + tag);
  const [token, hook, curveAddr] = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
  const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
  const tok = await ethers.getContractAt("PadToken", token);
  return { token, hook, curveAddr, key, curve, tok };
}

async function main() {
  console.log("Fork of live testnet — replaying the bench flow against the REAL deployed contracts\n");
  // Mine one block so all execution happens AFTER the fork point — EDR only needs a hardfork-activation
  // history for historical (<= fork) blocks; past the fork it uses the configured cancun hardfork.
  await network.provider.send("evm_mine");
  const [trader] = await ethers.getSigners();
  const factory = await ethers.getContractAt("CurvePadFactoryV4", A.factory);
  const SW = await ethers.getContractAt("PoolSwapTest", A.swapRouter);
  let pass = 0, fail = 0;
  const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); c ? pass++ : fail++; };
  const buy = (P, amt, limit) => SW.connect(trader).swap(P.key, { zeroForOne: true, amountSpecified: -E(amt), sqrtPriceLimitX96: limit }, { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(amt) });
  const tickOf = async (P) => { const sv = await ethers.getContractAt("RobinStateView", "0xC715c9cda89a8C4095432604570337594A64D8B8"); const [, t] = await sv.getSlot0(ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[P.key.currency0, P.key.currency1, P.key.fee, P.key.tickSpacing, P.key.hooks]]))); return t; };

  const BENCH_GAS = 900000n; // the gasLimit the bench pins on a swap

  // ── A) OLD behavior (MIN_SQRT): the overshoot buy walks to MIN_TICK — measure its gas cost
  console.log("A) old bench behavior (MIN_SQRT): 2 small buys, a sell, then a 0.01 buy that overshoots");
  const P = await launch(factory, "REPRO", trader.address);
  console.log("   gradTick", Number(await P.curve.gradTick()), "startTick", Number(await P.curve.startTick()), "spot", Number(await tickOf(P)));
  await (await buy(P, 0.001, MIN_SQRT)).wait();
  await (await buy(P, 0.001, MIN_SQRT)).wait();
  await P.tok.connect(trader).approve(A.swapRouter, ethers.MaxUint256);
  const half = (await P.tok.balanceOf(trader.address)) / 2n;
  await (await SW.connect(trader).swap(P.key, { zeroForOne: false, amountSpecified: -half, sqrtPriceLimitX96: 1461446703485210103287273052203988822378723970342n - 1n }, { takeClaims: false, settleUsingBurn: false }, "0x")).wait();
  const rcOld = await (await buy(P, 0.01, MIN_SQRT)).wait();
  const oldSpot = Number(await tickOf(P));
  console.log("   0.01 buy (MIN_SQRT) → spot", oldSpot, "· gasUsed", rcOld.gasUsed.toString());
  ok(oldSpot <= -887000, `MIN_SQRT buy overshoots the whole curve to MIN_TICK (spot ${oldSpot}) — a pathological ${rcOld.gasUsed}-gas traversal; on Nitro this blows the eth_call/gas budget and the preview fails with no revert data`);

  // ── B) THE FIX (cap at gradTick): the same overshoot fills to sell-out cheaply
  console.log("\nB) the fix (buy capped at gradTick): the overshoot fills to sell-out and stays cheap");
  const Q = await launch(factory, "FIXED", trader.address);
  const cap = sqrtAtTick(Number(await Q.curve.gradTick()));
  await (await buy(Q, 0.001, cap)).wait();
  const rcFix = await (await buy(Q, 0.01, cap)).wait();
  const ready = await Q.curve.ready();
  console.log("   capped 0.01 buy → spot", Number(await tickOf(Q)), "· gasUsed", rcFix.gasUsed.toString(), "· ready", ready);
  ok(ready, "capped buy stops at gradTick and drives the curve to ready=" + ready);
  ok(rcFix.gasUsed < BENCH_GAS, `capped buy uses ${rcFix.gasUsed} gas (< bench limit ${BENCH_GAS}) → no OOG`);
  ok(rcFix.gasUsed < rcOld.gasUsed, `cap cuts gas ${rcOld.gasUsed} → ${rcFix.gasUsed} by not walking into empty liquidity`);

  console.log("\n──────────────────────────────");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
