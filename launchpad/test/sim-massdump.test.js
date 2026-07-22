const { expect } = require("chai");
const { ethers } = require("hardhat");

// ============================================================================
// Operator's exact fear, simulated on a REAL Uniswap v3 fork of Robinhood Chain:
//   many wallets buy a fresh coin up ~2x, then EVERYONE dumps in sequence.
// Asserts:
//   (a) every sell tx SUCCEEDS (no revert) — not a honeypot; the pool always pays.
//   (b) total ETH paid out to all sellers <= total ETH buyers put in (solvency:
//       nobody extracts more than was deposited).
//   (c) the LAST seller (worst price, pool most drained) still gets a non-zero payout.
//
// Trades go DIRECTLY against the raw Uniswap v3 pool via SwapProbe — bypassing the
// PadRouter entirely — so this is the strongest possible anti-honeypot proof: even
// with zero launchpad cooperation, the underlying pool honors every sell.
//
// Run: FORK_RPC=<rpc> npx hardhat test test/sim-massdump.test.js
// ============================================================================
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// Production "let it ride" calibration from scripts/deploy.js:
//   START_TICK_MAG=201600, CURVE_WIDTH=23000, MIN_GRAD_WIDTH=22800  (~$34k / ~4.2 ETH graduation)
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Mass-dump sim — buy a coin up ~2x, then everyone dumps (fork)", function () {
  this.timeout(300000);

  it("every sell succeeds, out<=in (solvent), last seller still paid", async () => {
    const signers = await ethers.getSigners();
    const [dep, platform, dev] = signers;
    const buyers = signers.slice(3, 13); // 10 independent dumper wallets

    // --- deploy the production stack against the real v3 factory ---
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    );
    await (await router.setFactory(await factory.getAddress())).wait();

    // launch a plain 1% (no project tax) coin
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "DUMP", symbol: "DUMP", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;

    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const TOK = await ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], token);
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const gradSqrt = await curveC.gradSqrtPriceX96();

    // token0 ordering — price of the token in WETH from sqrtPriceX96
    const token0 = (await pool.token0()).toLowerCase();
    const tokenIsToken0 = token0 === token.toLowerCase();
    // price(token in WETH) = tokenIsToken0 ? (sqrtP/2^96)^2 : (2^96/sqrtP)^2. Compare via a scaled ratio.
    const sqrtStart = (await pool.slot0()).sqrtPriceX96;

    // skip past the whole anti-snipe window so buys trade freely (this sim is about a NORMAL, live coin)
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // ===== PHASE 1: everyone buys, pushing the price up =====
    let totalIn = 0n;
    const bought = []; // tokens each buyer ended up holding
    for (const b of buyers) {
      const spend = ethers.parseEther("0.35"); // ~3.5 ETH total across 10 wallets -> well up the curve
      await (await wethW.connect(b).deposit({ value: spend })).wait();
      await (await wethW.connect(b).approve(probeAddr, spend)).wait();
      const wBefore = await wethW.balanceOf(b.address);
      // cap the buy at the graduation price so we never tip into/over the ceiling
      await (await probe.connect(b).swapExactInLimit(poolAddr, WETH, spend, gradSqrt)).wait();
      const wAfter = await wethW.balanceOf(b.address);
      totalIn += (wBefore - wAfter); // ACTUAL weth consumed by the swap
      bought.push(await TOK.balanceOf(b.address));
    }

    const sqrtPeak = (await pool.slot0()).sqrtPriceX96;
    // price multiple = (peak/start)^2 (token is token0) or (start/peak)^2 (token is token1)
    const num = tokenIsToken0 ? sqrtPeak : sqrtStart;
    const den = tokenIsToken0 ? sqrtStart : sqrtPeak;
    const priceMultX1000 = (num * num * 1000n) / (den * den);

    // ===== PHASE 2: EVERYONE dumps their full bag, in order =====
    let totalOut = 0n;
    let firstPrice = 0n, lastPrice = 0n, lastOut = 0n;
    const outs = [];
    for (let i = 0; i < buyers.length; i++) {
      const b = buyers[i];
      const bag = await TOK.balanceOf(b.address);
      expect(bag, `buyer ${i} should hold tokens`).to.be.greaterThan(0n);
      await (await TOK.connect(b).approve(probeAddr, bag)).wait();
      const wBefore = await wethW.balanceOf(b.address);
      // (a) NO honeypot: a plain exact-in sell against the raw pool must not revert
      await (await probe.connect(b).swapExactIn(poolAddr, token, bag)).wait();
      const wAfter = await wethW.balanceOf(b.address);
      const out = wAfter - wBefore;
      outs.push(out);
      totalOut += out;
      // realized sell price = weth received per token dumped (1e18-scaled)
      const realized = (out * ONE) / bag;
      if (i === 0) firstPrice = realized;
      lastPrice = realized;
      lastOut = out;
    }

    // ===== INVARIANTS =====
    // (c) the last seller — worst price, pool most drained — is still paid something
    expect(lastOut, "last seller payout must be non-zero (pool can always pay)").to.be.greaterThan(0n);
    // (a) reiterate: every payout was strictly positive => every sell filled
    for (let i = 0; i < outs.length; i++) {
      expect(outs[i], `seller ${i} received 0 weth`).to.be.greaterThan(0n);
    }
    // (b) SOLVENCY: sellers cannot, in aggregate, pull out more ETH than buyers put in
    expect(totalOut, "solvency: total ETH out must be <= total ETH in").to.be.lessThanOrEqual(totalIn);

    const f = (x) => Number(ethers.formatEther(x));
    console.log("\n      ===== MASS-DUMP RESULT (real Uniswap v3 fork) =====");
    console.log(`      buyers/sellers:        ${buyers.length}`);
    console.log(`      total ETH IN  (buys):  ${f(totalIn).toFixed(6)} ETH`);
    console.log(`      total ETH OUT (dumps): ${f(totalOut).toFixed(6)} ETH`);
    console.log(`      net kept by pool/fees: ${f(totalIn - totalOut).toFixed(6)} ETH  (out/in = ${(f(totalOut) / f(totalIn) * 100).toFixed(2)}%)`);
    console.log(`      price peak vs launch:  ${(Number(priceMultX1000) / 1000).toFixed(2)}x`);
    console.log(`      first seller price:    ${f(firstPrice).toExponential(4)} ETH/token`);
    console.log(`      last  seller price:    ${f(lastPrice).toExponential(4)} ETH/token`);
    console.log(`      first/last price drop: ${(Number(firstPrice) / Number(lastPrice)).toFixed(2)}x`);
    console.log(`      last seller payout:    ${f(lastOut).toExponential(4)} ETH  (non-zero ✓)`);
    console.log("      =================================================\n");
  });
});
