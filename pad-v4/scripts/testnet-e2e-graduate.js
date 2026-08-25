/* LIVE TESTNET END-TO-END (through GRADUATION) — Robinhood testnet has no v4 PositionManager, so this deploys a
 * MockPositionManagerV4 (+ MockPermit2), stands up a graduation-capable curve suite pointed at it, then runs the
 * WHOLE lifecycle ON-CHAIN: launch a small pad → sell it out to the ceiling → graduate → verify the permanent LP is
 * LOCKED to the LockVault, the platform/creator books pay, the reserve streams to staking, and a POST-grad buy's
 * ETH buffer is swept to the platform. Real v4 graduation is separately proven on the mainnet fork; this proves the
 * full flow works continuously on a real (non-fork) chain. Run:
 *   npx hardhat run scripts/testnet-e2e-graduate.js --network robinhoodTestnet
 */
const { ethers } = require("hardhat");
const { mineHookSalt, hookInitCode } = require("./mine");
const { bindSalt } = require("../test/helpers/brand");

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const T0 = { type: 0 };
const ONE = 10n ** 18n;

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
const ex = (h) => `https://explorer.testnet.chain.robinhood.com/tx/${h}`;

async function dep(name, args = []) {
  const c = await (await ethers.getContractFactory(name)).deploy(...args, T0);
  await c.waitForDeployment();
  return c;
}

async function main() {
  const [w] = await ethers.getSigners();
  console.log(`E2E graduation on Robinhood testnet as ${w.address}\n`);

  // ── mocks: a v4 PositionManager stand-in (+ its Permit2) so graduation can mint the locked LP on testnet ──
  const permit2 = await dep("MockPermit2");
  const posm = await dep("MockPositionManagerV4", [POOL_MANAGER, await permit2.getAddress()]);
  console.log(`  MockPermit2            ${await permit2.getAddress()}`);
  console.log(`  MockPositionManagerV4  ${await posm.getAddress()}`);

  // ── graduation-capable suite wired to the mock posm ──
  const dd = await dep("DeterministicDeployer");
  const reg = await dep("FeeWalletRegistry", [w.address, w.address]);
  const lockVault = await dep("LockVault", [await posm.getAddress(), await reg.getAddress()]);
  const stateView = await dep("RobinStateView", [POOL_MANAGER]);
  const curveDep = await dep("CurveV4Deployer", [await dd.getAddress()]);
  const START = 201600, WIDTH = 23000, GRAD = START - WIDTH, TS = 100, FEE = 10000;
  const feeCfg = await dep("RobinV4FeeConfig", [w.address, {
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 2500,
    platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
    lpFee: FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: 22800,
    // [FDV] band deliberately OPEN in this fixture: these tests exercise curve mechanics over many toy
    // supplies, not the product's valuation policy. The band itself is proven in FDV.creator-supply.test.js.
    minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n, // = HARD_MAX_FDV_WEI
  }]);
  const factory = await dep("CurvePadFactoryV4", [
    POOL_MANAGER, await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dd.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress(),
  ]);
  await (await lockVault.setFactory(await factory.getAddress(), T0)).wait();
  const SW = await dep("PoolSwapTest", [POOL_MANAGER]);
  console.log(`  CurvePadFactoryV4      ${await factory.getAddress()}\n  swap router            ${await SW.getAddress()}\n`);

  // ── launch a SMALL pad so a tiny buy sells it out (production geometry, but curve=100k tokens) ──
  const cfg = { name: "Robin E2E", symbol: "rE2E", decimals: 18, supply: 200_000n * ONE, curveSupply: 100_000n * ONE, reserveSupply: 100_000n * ONE, tickSpacing: TS, startTickMag: 0, creator: w.address };
  const TokenF = await ethers.getContractFactory("PadToken");
  const tokenSalt = ethers.id("e2e-" + Date.now());
  const tokenInit = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, 18, cfg.supply, await factory.getAddress()])]);
  const predicted = ethers.getCreate2Address(await dd.getAddress(), bindSalt(cfg, tokenSalt), ethers.keccak256(tokenInit));
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(await dd.getAddress(), hookInitCode(HookF.bytecode, POOL_MANAGER, await factory.getAddress(), await reg.getAddress(), predicted));
  const curveSalt = ethers.id("e2ec-" + Date.now()); // ONE salt for both the staticCall prediction and the real launch
  const [token, hook, curveAddr] = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  const ltx = await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt, T0)).wait();
  console.log(`✓ launched pad  token ${token}  curve ${curveAddr}\n  ${ex(ltx.hash)}`);

  const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
  const poolId = ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[ZERO, token, FEE, TS, hook]]));
  const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
  const hookC = await ethers.getContractAt("RobinFeeHook", hook);
  const tok = await ethers.getContractAt("PadToken", token);
  const tick = async () => Number((await stateView.getSlot0(poolId))[1]);

  // ── wire staking so the graduation reserve stream has a home ──
  const ds = await dep("DualStaking", [token, ZERO, w.address, 0, ZERO, ethers.ZeroHash, 0]);
  await (await ds.setRewarder(curveAddr, true, T0)).wait();
  await (await ds.listReward(0, token, 7 * 86400, T0)).wait();
  await (await curve.setStaking(await ds.getAddress(), T0)).wait();

  // ── sell the curve OUT: buy with a price cap at the graduation ceiling (consumes ~the raise, refunds the rest) ──
  const gradSqrt = sqrtAtTick(GRAD);
  // send a modest amount capped at the graduation ceiling: the swap consumes only ~the raise (~0.0006 ETH) and the
  // rest is refunded, so this fits a small hot-wallet balance while still selling the curve out to gradTick.
  const bt = await (await SW.swap(key, { zeroForOne: true, amountSpecified: -ethers.parseEther("0.004"), sqrtPriceLimitX96: gradSqrt }, { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("0.004"), ...T0 })).wait();
  console.log(`✓ bought out → tick ${await tick()} (ceiling ${GRAD}), ready=${await curve.ready()}\n  ${ex(bt.hash)}`);

  // ── GRADUATE ──
  const idBefore = await posm.nextTokenId();
  const gt = await (await curve.graduate(T0)).wait();
  console.log(`✓ GRADUATED  ${ex(gt.hash)}`);
  console.log(`  graduated flag    ${await curve.graduated()}`);
  console.log(`  spot @ ceiling    ${await tick()} (== ${GRAD})`);
  console.log(`  permanent LP NFT owner == LockVault: ${(await posm.ownerOf(idBefore)) === await lockVault.getAddress()}`);
  console.log(`  staking funded    ${ethers.formatUnits(await tok.balanceOf(await ds.getAddress()), 18)} rE2E`);
  console.log(`  platformEthOwed   ${ethers.formatEther(await curve.platformEthOwed())} ETH`);
  console.log(`  creatorEthOwed    ${ethers.formatEther(await curve.creatorEthOwed())} ETH`);
  const cb = await ethers.provider.getBalance(w.address);
  await (await curve.claimCreator(T0)).wait();
  console.log(`  claimCreator paid: ${(await ethers.provider.getBalance(w.address)) > cb}`);

  // ── POST-GRAD buffer → platform: a buy on the permanent LP still taxes; claimBuffer → curve → sweepToPlatform ──
  await (await SW.swap(key, { zeroForOne: true, amountSpecified: -ethers.parseEther("0.0005"), sqrtPriceLimitX96: 4295128740n }, { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("0.0005"), ...T0 })).wait();
  await (await hookC.claimBuffer(poolId, T0)).wait();
  const pb = await curve.platformEthOwed();
  await (await curve.sweepToPlatform(T0)).wait();
  console.log(`  post-grad buffer → platform: ${(await curve.platformEthOwed()) > pb}`);
  console.log(`\n✓ END-TO-END COMPLETE on Robinhood testnet (launch → sellout → graduate → locked LP → post-grad sweep)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
