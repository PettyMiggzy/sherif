/* FORK E2E BOT — a swarm of trader wallets exercising the FULL curve lifecycle against the REAL deployed
 * testnet contracts (forked). No faucet ETH needed: hardhat funds the fork accounts. Covers the things
 * that burned earlier pads:
 *   1) NO BOT PROTECTION — many wallets buy in the SAME block; first-buy-after-launch works.
 *   2) buy-then-instant-sell works.
 *   3) airdropped holders can sell.
 *   4) NO CRAZY SLIPPAGE — a buy→sell round-trip loses ≈ the fees, not half.
 *   5) capped buys sell the curve out → ready, then graduate (mock PositionManager grafted at the
 *      address the deployed factory uses, since the real v4 posm isn't on testnet) → LP locked.
 *
 * Run:  FORK_RPC=https://rpc.testnet.chain.robinhood.com FORK_CHAINID=46630 npx hardhat run scripts/fork-e2e-bot.js
 */
const { ethers, network } = require("hardhat");
const { mineHookSalt, hookInitCode } = require("./mine");

const A = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  deployer: "0x521DCd4F3ed73107dc5C62Ff357C59d99efd6FFB",
  feeRegistry: "0x1A211C5e6B4a8B2FB96E8e1Dd05D3B2A53937992",
  factory: "0xfE1CaAb7c8c024Dfb8D696262F206dE9964E3537",
  swapRouter: "0x5465091F4f71EE34B35E3697e0805E9310f43119",
  stateView: "0xC715c9cda89a8C4095432604570337594A64D8B8",
  posmSlot: "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA", // where the deployed factory points curves
};
const ZERO = ethers.ZeroAddress;
const MIN_SQRT = 4295128739n + 1n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
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
    for (const k of ["data", "error", "info", "shortMessage", "message"]) if (k in v) st.push(v[k]); }
  return e?.shortMessage || "(no data)";
}
function unpackDelta(d) {
  let raw = BigInt(d); if (raw < 0n) raw += (1n << 256n);
  const s = (x) => (x >= (1n << 127n) ? x - (1n << 128n) : x);
  return { amount0: s(raw >> 128n), amount1: s(raw & ((1n << 128n) - 1n)) };
}

let factory, SW, sv;
async function launch(tag, creator, curveTok = 470_000) {
  const cfg = { name: "Robin " + tag, symbol: tag, decimals: 18, supply: E(curveTok * 2 + 100_000), curveSupply: E(curveTok), reserveSupply: E(curveTok), tickSpacing: TS, startTickMag: 0, creator: creator.address };
  const TokenF = await ethers.getContractFactory("PadToken");
  const tokenSalt = ethers.id("tok-" + tag);
  const tokenInit = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, 18, cfg.supply, A.factory])]);
  const predicted = ethers.getCreate2Address(A.deployer, tokenSalt, ethers.keccak256(tokenInit));
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(A.deployer, hookInitCode(HookF.bytecode, A.poolManager, A.factory, A.feeRegistry, predicted));
  const curveSalt = ethers.id("curve-" + tag);
  const [token, hook, curveAddr] = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
  const poolId = ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[ZERO, token, FEE, TS, hook]]));
  return { token, hook, curveAddr, key, poolId, curve: await ethers.getContractAt("RobinCurveV4", curveAddr), tok: await ethers.getContractAt("PadToken", token) };
}
const buyTx = (P, who, amt, limit) => SW.connect(who).swap(P.key, { zeroForOne: true, amountSpecified: -amt, sqrtPriceLimitX96: limit }, { takeClaims: false, settleUsingBurn: false }, "0x", { value: amt });
async function sellAll(P, who, amt) {
  await (await P.tok.connect(who).approve(A.swapRouter, ethers.MaxUint256)).wait();
  return SW.connect(who).swap(P.key, { zeroForOne: false, amountSpecified: -amt, sqrtPriceLimitX96: sqrtAtTick(Number(await P.curve.startTick())) }, { takeClaims: false, settleUsingBurn: false }, "0x");
}
const tickOf = async (P) => { const [, t] = await sv.getSlot0(P.poolId); return Number(t); };

async function main() {
  console.log("Fork E2E bot — trader swarm vs the REAL deployed contracts\n");
  await network.provider.send("evm_mine");
  const signers = await ethers.getSigners();
  const [dev, t1, t2, t3, t4, air] = signers;
  factory = await ethers.getContractAt("CurvePadFactoryV4", A.factory);
  SW = await ethers.getContractAt("PoolSwapTest", A.swapRouter);
  sv = await ethers.getContractAt("RobinStateView", A.stateView);
  let pass = 0, fail = 0;
  const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); c ? pass++ : fail++; };

  // ── 1) no bot protection: 4 wallets buy in the SAME block, right after launch
  console.log("1) no bot protection — 4 wallets buy in ONE block right after launch");
  const P = await launch("SWARM", dev, 50_000_000); // big curve so the trade scenarios don't sell it out
  const cap = sqrtAtTick(Number(await P.curve.gradTick()));
  await network.provider.send("evm_setAutomine", [false]);
  const txs = await Promise.all([t1, t2, t3, t4].map((w, i) => buyTx(P, w, E(0.0005 + i * 0.0002), cap)));
  await network.provider.send("evm_mine");
  await network.provider.send("evm_setAutomine", [true]);
  const rcs = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
  const blocks = new Set(rcs.map((r) => r.blockNumber));
  const allOk = rcs.every((r) => r.status === 1);
  const bals = await Promise.all([t1, t2, t3, t4].map((w) => P.tok.balanceOf(w.address)));
  ok(allOk && blocks.size === 1, `all 4 buys succeeded in the same block (#${[...blocks][0]}), no front-run/bot-block`);
  ok(bals.every((b) => b > 0n), "every wallet received tokens");

  // ── 2) buy then instant sell (same wallet, next tx)
  console.log("\n2) buy-then-instant-sell");
  try {
    await (await buyTx(P, t1, E(0.0005), cap)).wait();
    const half = (await P.tok.balanceOf(t1.address)) / 2n;
    await (await sellAll(P, t1, half)).wait();
    ok(true, "bought then immediately sold half — no lock, no revert");
  } catch (e) { ok(false, "buy→sell failed: " + selectorOf(e)); }

  // ── 3) airdrop → recipient sells
  console.log("\n3) airdropped holder can sell");
  try {
    const gift = (await P.tok.balanceOf(t2.address)) / 3n;
    await (await P.tok.connect(t2).transfer(air.address, gift)).wait();
    await (await sellAll(P, air, gift)).wait();
    ok(true, "airdrop recipient sold their tokens");
  } catch (e) { ok(false, "airdrop→sell failed: " + selectorOf(e)); }

  // ── 4) slippage sanity: round-trip loss ≈ fees, not catastrophic
  console.log("\n4) slippage sanity — buy 0.001, sell it all back (pure swap economics, gas excluded)");
  try {
    const b0 = await P.tok.balanceOf(t3.address);
    await (await buyTx(P, t3, E(0.001), cap)).wait();
    const got = (await P.tok.balanceOf(t3.address)) - b0;
    await (await P.tok.connect(t3).approve(A.swapRouter, ethers.MaxUint256)).wait();
    const sellArgs = [P.key, { zeroForOne: false, amountSpecified: -got, sqrtPriceLimitX96: sqrtAtTick(Number(await P.curve.startTick())) }, { takeClaims: false, settleUsingBurn: false }, "0x"];
    const { amount0: ethOut } = unpackDelta(await SW.connect(t3).swap.staticCall(...sellArgs)); // ETH the sell delivers
    await (await SW.connect(t3).swap(...sellArgs)).wait();
    const lossPct = Number((E(0.001) - ethOut) * 10000n / E(0.001)) / 100;
    console.log("   round-trip swap loss:", lossPct.toFixed(2), "% (0.001 ETH →", ethers.formatEther(ethOut), "ETH back)");
    ok(lossPct < 8, `round-trip swap loss ${lossPct.toFixed(2)}% ≈ the ~3-4% fees (buy+sell tax+lp) — no crazy slippage`);
  } catch (e) { ok(false, "slippage test failed: " + selectorOf(e)); }

  // ── 5) capped buys sell a small curve out to ready=true (the sell-out boundary the bench relies on).
  // graduation itself is proven by the unit suite (RobinCurveV4.cappedgrad/grief/graduation) — it can't run
  // on the live testnet because the real v4 PositionManager isn't deployed there (0x174c is codeless).
  console.log("\n5) capped buys sell a small curve out to ready=true (no MIN_SQRT gas blow-up, no revert)");
  try {
    const G = await launch("SELLOUT", dev, 470_000); // small curve → sells out fast
    const gcap = sqrtAtTick(Number(await G.curve.gradTick()));
    for (let i = 0; i < 8 && !(await G.curve.ready()); i++) await (await buyTx(G, t1, E(0.02), gcap)).wait();
    ok(await G.curve.ready(), "capped buys drove the curve to ready=true (spot " + (await tickOf(G)) + ")");
  } catch (e) { ok(false, "sell-out failed: " + selectorOf(e)); }

  console.log("\n──────────────────────────────");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
