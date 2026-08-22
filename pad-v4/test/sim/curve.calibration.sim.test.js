const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { brandedTokenSalt } = require("../helpers/brand");

// SIM — CALIBRATION at the REAL production geometry (not the toy START=6000 the other sims use).
// Ports the proven V3 curve to V4 and PROVES the headline economics on the actual V4 curve impl:
//   START_TICK_MAG 201600, CURVE_WIDTH 23000 (≈10x), ts=100, 1B supply @ 73% curve / 27% reserve
//   → start MC ~$3.4k, graduate MC ~$34k, ~4.2 ETH raised, 10x chart.
// The multiple (grad/start) and the ETH raise are geometry/supply-fixed (ethUsd-independent); the USD market
// caps are shown at ethUsd=$1900 (the FX that maps this geometry to the ~$3.4k/$34k targets).

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const ONE = 10n ** 18n;

const START = 201600, WIDTH = 23000, GRAD = START - WIDTH, TS = 100, FEE = 10000, MINGRAD = 22800;
const SUPPLY = 1_000_000_000n * ONE;
const CURVE = 730_000_000n * ONE;   // 73% sold on the curve
const RESERVE = 270_000_000n * ONE; // 27% held back (pairs the permanent LP + feeds staking)
const ETH_USD = 1900;

// token is currency1: price P (=1.0001^tick) is token-per-ETH, so ETH-per-token = 1/P and
// market cap (whole ETH) = totalSupplyWholeTokens / P.
const mcEth = (tick) => 1e9 / Math.pow(1.0001, tick);
const mcUsd = (tick) => mcEth(tick) * ETH_USD;

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("SIM — production-geometry calibration (start ~$3.4k, graduate ~$34k, ~4.2 ETH, 10x)", () => {
  it("launches at V3 geometry and reproduces the headline market caps + raise on the V4 curve", async () => {
    const [deployer, platform, creator, whale] = await ethers.getSigners();

    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
    const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: MINGRAD,
      // [FDV] band deliberately OPEN in this fixture: these tests exercise curve mechanics over many toy
      // supplies, not the product's valuation policy. The band itself is proven in FDV.creator-supply.test.js.
      minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n, // = HARD_MAX_FDV_WEI
    });
    const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());

    // launch: no-mint 1B @ 750M curve / 250M reserve, tickSpacing 100
    const cfg = { name: "Calibrate", symbol: "CAL", decimals: 18, supply: SUPPLY, curveSupply: CURVE, reserveSupply: RESERVE, tickSpacing: TS, startTickMag: 0, creator: creator.address };
    // [brand] the token address must end in `1ab5` (PadBrand.requireBrand) — mine the salt exactly like production.
    const tokenSalt = await brandedTokenSalt(await dep.getAddress(), await factory.getAddress(), cfg, ethers.id("cal-tok"));
    const curveSalt = ethers.id("cal-curve");
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenInit = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await factory.getAddress()])]);
    const predictedToken = ethers.getCreate2Address(await dep.getAddress(), tokenSalt, ethers.keccak256(tokenInit));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(await dep.getAddress(), hookInitCode(HookF.bytecode, await pm.getAddress(), await factory.getAddress(), await reg.getAddress(), predictedToken));

    const [token, hook, curveAddr] = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
    await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
    const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
    const poolId = poolIdOf(key);
    const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
    const th = await (await ethers.getContractFactory("TickHelper")).deploy();
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    const tokC = await ethers.getContractAt("PadToken", token);

    // ── start: the pool inits at startTick (curve top) ──
    const startTick = Number((await stateView.getSlot0(poolId))[1]);
    expect(startTick).to.equal(START);
    const startMc = mcUsd(startTick);

    // ── buy the curve OUT, capping EXACTLY at the graduation price (gradSqrt) so spot lands on the ceiling ──
    // Size the exact-input a modest margin ABOVE the ~4.1 ETH principal (not a huge 1000 ETH): the buy tax is a
    // fee-on-INPUT computed on the REQUESTED amount, so a wildly oversized request would over-tax the whale on ETH
    // that never swaps. E(6) fills the curve (principal ≈ 4.1 < 6 − fee) while keeping the fee realistic.
    const gradSqrt = await th.sqrt(GRAD);
    const wBefore = await ethers.provider.getBalance(whale.address);
    const rc = await (await sw.connect(whale).swap(
      key, { zeroForOne: true, amountSpecified: -E(6), sqrtPriceLimitX96: gradSqrt },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(6) }
    )).wait();
    const spent = wBefore - await ethers.provider.getBalance(whale.address) - rc.gasUsed * rc.gasPrice;
    // the RAISE = the pool PRINCIPAL (what graduation distributes) = whale spend − the buy tax (which is money the
    // platform collects, not raise). The buy tax is minted as an ERC-6909 claim; read it back and subtract.
    const buyTax = await pm.balanceOf(hook, 0n); // ERC-6909 native-ETH claim (the whole buy tax)
    const raise = spent - buyTax;
    const gradT = Number((await stateView.getSlot0(poolId))[1]);
    const tokBought = Number(await tokC.balanceOf(whale.address)) / 1e18;
    expect(await curve.ready()).to.equal(true);           // reached the ceiling
    expect(gradT).to.be.closeTo(GRAD, TS);                // spot at the ceiling (gradTick)
    // buy tax is now ETH (fee-on-input), so NO token is skimmed — the buyer gets the whole 730M curve.
    expect(tokBought).to.be.within(690e6, 735e6);         // ~the whole 730M curve
    const gradMc = mcUsd(GRAD);
    const multiple = mcEth(GRAD) / mcEth(startTick);
    const raiseEth = Number(raise) / 1e18;

    console.log(`      start MC ~$${Math.round(startMc).toLocaleString()} | grad MC ~$${Math.round(gradMc).toLocaleString()} | raise ${raiseEth.toFixed(2)} ETH | ${multiple.toFixed(1)}x`);

    // ── assertions: the headline economics hold on the real V4 curve ──
    expect(startMc).to.be.within(2600, 4400);   // target ~$3.4k
    expect(gradMc).to.be.within(27000, 43000);  // target ~$34k
    expect(multiple).to.be.within(9, 11);       // ~10x chart (geometry-fixed, ethUsd-independent)
    expect(raiseEth).to.be.within(3.2, 6.5);    // target ~4.2 ETH pool principal
  });
});
