const { expect } = require("chai");
const { ethers } = require("hardhat");

// Graduation battery against real Uniswap v3 on Robinhood Chain: launch many coins and graduate each at the
// full ceiling (the ONLY graduation point), asserting the invariants after every graduation. Crank it up:
//   SIMS=30 FORK_RPC=<rpc> npx hardhat test test/fork/graduation-sim.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const SIMS = Number(process.env.SIMS || 6);

// deterministic RNG (seeded LCG) so runs are reproducible
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Graduation battery — graduate at the ceiling, invariants hold every time", function () {
  // Each graduation is a full launch+swap+graduate round-trip against a LIVE fork RPC, so 300 of them is a
  // wall-clock (not compute) cost. Scale the ceiling with SIMS so a big battery can't die on the mocha timeout.
  this.timeout(Math.max(30, SIMS * 2) * 60 * 1000);

  it(`launches + graduates ${SIMS} coins at the ceiling; invariants + conservation hold`, async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    // production let-it-ride geometry
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    // Each graduation permanently sinks ~4-25 ETH of the buyer's WETH into the pool/Bond, so a fixed one-shot
    // deposit runs dry at high SIMS and aborts the battery mid-run. Give the buyer a huge native balance and
    // top the WETH working balance back up before any swap that could exceed it — the budget must never be the
    // thing that "fails" a 300-run battery.
    await ethers.provider.send("hardhat_setBalance", [buyer.address, "0x" + (10n ** 24n).toString(16)]); // 1,000,000 ETH
    await (await wethW.connect(buyer).deposit({ value: 500n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 1n << 250n)).wait();
    const topUpWeth = async () => { // keep >= one worst-case swap (60 ETH) in hand
      if ((await wethW.balanceOf(buyer.address)) < 80n * ONE) await (await wethW.connect(buyer).deposit({ value: 500n * ONE })).wait();
    };
    const tokAbi = ["function balanceOf(address) view returns (uint256)"];

    for (let i = 0; i < SIMS; i++) {
      const rc = await (await factory.launch({ name: `S${i}`, symbol: `S${i}`, dev: dev.address, tax: NOTAX })).wait();
      const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
      const { token, curve, pool: poolAddr } = ev.args;
      const curveC = await ethers.getContractAt("CurvePool", curve);
      const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
      const TOK = await ethers.getContractAt(tokAbi, token);

      await ethers.provider.send("evm_increaseTime", [400]);
      await ethers.provider.send("evm_mine", []);

      // buy all the way to the ceiling — the ONLY graduation point
      await topUpWeth(); // refill the buyer's WETH so a big battery never aborts on budget
      expect(await curveC.ready(), `#${i} not ready before the ceiling`).to.equal(false);
      await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, await curveC.gradSqrtPriceX96())).wait();
      expect(await curveC.ready(), `#${i} ready at the ceiling`).to.equal(true);

      const devBefore = await wethW.balanceOf(dev.address);
      const platformAddr = await curveC.platform();
      const platBefore = await wethW.balanceOf(platformAddr);
      await (await curveC.graduate()).wait();
      const bond = await ethers.getContractAt("Bond", await curveC.bond());

      // INV-1: the Bond always posts a real floor
      expect(await bond.posted(), `#${i} posted`).to.equal(true);
      expect(await bond.sherwoodL(), `#${i} sherwoodL`).to.be.greaterThan(0n);
      expect(await bond.bountyL(), `#${i} bountyL`).to.be.greaterThan(0n);

      // INV-2: creator + platform each get a FIXED 0.5 WETH (capped at raise/4). At these raises (>=4 ETH)
      // that's exactly 0.5 each; the platform also sweeps a tiny WETH dust on top.
      const HALF = ethers.parseEther("0.5");
      const devGain = (await wethW.balanceOf(dev.address)) - devBefore;
      const platGain = (await wethW.balanceOf(platformAddr)) - platBefore;
      expect(devGain, `#${i} dev reward`).to.equal(HALF);
      // v2: graduate() sweeps pending LP fees too (100% to platform, feeConfig unset) → 0.5 reward + fee slice.
      expect(platGain, `#${i} platform reward (0.5) + swept LP fees`).to.be.gte(HALF);
      expect(platGain, `#${i} platform gain is 0.5 + a modest LP-fee slice`).to.be.lte(ethers.parseEther("0.75"));

      // INV-3: the curve is fully drained — no WETH or token stranded in it
      expect(await wethW.balanceOf(curve), `#${i} curve weth`).to.equal(0n);
      expect(await TOK.balanceOf(curve), `#${i} curve token`).to.equal(0n);

      // INV-4: the pool holds real liquidity after graduation (tradeable)
      expect(await pool.liquidity(), `#${i} pool liq`).to.be.greaterThan(0n);

      if ((i + 1) % 20 === 0) console.log(`      …${i + 1}/${SIMS} graduated, invariants held`);
    }

    console.log(`      ${SIMS} graduations at the ceiling: invariants + conservation held every time.`);
  });
});
