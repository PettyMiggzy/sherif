const { expect } = require("chai");
const { ethers } = require("hardhat");

// ============================================================================
// RANDOMIZED CONSERVATION / SOLVENCY SIM on a REAL Uniswap v3 fork of Robinhood
// Chain. Many actors buy & sell one fresh coin in a long randomized, interleaved
// sequence (hundreds of ops). After EVERY op we assert:
//
//   (1) CONSERVATION (exact): pool WETH balance == initialPoolWeth + Σbuys - Σsells.
//       In this architecture the bonding curve IS the v3 pool and WETH only ever
//       moves buyer<->pool, so this must hold to the wei. A mismatch = WETH leaking.
//
//   (2) SOLVENCY: Σsells (all ETH ever paid out) <= Σbuys (all ETH ever put in).
//       Nobody can extract more ETH than was deposited; the pool never owes more
//       than it holds. Equivalent to poolWeth >= 0, asserted against measured flows.
//
//   (3) NO SELL EVER REVERTS (anti-honeypot). Every sell tx must succeed, and while
//       the pool still holds WETH every sell must pay out > 0 (the pool can always
//       pay a seller). A 0-payout sell is only tolerated when the pool is drained to
//       the curve floor (correct: there is simply nothing left to hand back).
//
// Trades go DIRECTLY against the raw Uniswap v3 pool via SwapProbe — bypassing the
// PadRouter — so this is the strongest possible proof the underlying pool honors it.
//
// Run: FORK_RPC=<rpc> npx hardhat test test/sim-conservation.test.js
// ============================================================================
const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// Production "let it ride" calibration from scripts/deploy.js
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

const N_OPS = 360;     // >> "a few hundred"
const N_ACTORS = 8;
const DUST = 10n ** 9n; // 1 gwei: below this the pool counts as "drained to floor"

// deterministic PRNG (mulberry32) so a failure is reproducible
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Randomized conservation/solvency sim — many actors, interleaved buys+sells (fork)", function () {
  this.timeout(600000);

  it("conservation holds and no sell reverts across hundreds of random ops", async () => {
    const signers = await ethers.getSigners();
    const [dep, platform, dev] = signers;
    const actors = signers.slice(3, 3 + N_ACTORS);

    // ── deploy the production stack against the real v3 factory ──────────────
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress,
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    );
    await (await router.setFactory(await factory.getAddress())).wait();

    // launch a plain 1% (no project tax) coin
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "SIM", symbol: "SIM", dev: dev.address, tax: NOTAX })).wait();
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
    const gradSqrt = await curveC.gradSqrtPriceX96(); // cap buys at the ceiling; never run into empty space
    const MAX = (1n << 250n);

    // ── fund every actor once: ETH -> lots of WETH, max approvals (avoid per-op setup txs)
    for (const a of actors) {
      await ethers.provider.send("hardhat_setBalance", [a.address, "0x" + (10n ** 24n).toString(16)]);
      await (await wethW.connect(a).deposit({ value: 40n * ONE })).wait();
      await (await wethW.connect(a).approve(probeAddr, MAX)).wait();
      await (await TOK.connect(a).approve(probeAddr, MAX)).wait();
    }

    // skip past the anti-snipe window so this is a normal live coin
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    const initialPoolWeth = await wethW.balanceOf(poolAddr); // single-sided seed => expected 0

    let totalIn = 0n;    // Σ WETH consumed by buys (measured)
    let totalOut = 0n;   // Σ WETH received by sells (measured)
    let buys = 0, sells = 0, zeroBuys = 0, zeroPayoutSells = 0, forcedBuys = 0;
    let sellReverts = 0, firstSellRevert = null;
    let worstConservationDelta = 0n;
    const rand = rng(0xC0FFEE);

    for (let i = 0; i < N_OPS; i++) {
      const a = actors[Math.floor(rand() * actors.length)];
      let doBuy = rand() < 0.5;
      const bag = await TOK.balanceOf(a.address);
      if (!doBuy && bag === 0n) { doBuy = true; forcedBuys++; } // can't sell what you don't hold

      if (doBuy) {
        const amt = (ONE / 100n) + BigInt(Math.floor(rand() * Number(ONE / 5n))); // 0.01 .. ~0.21 ETH
        const wBefore = await wethW.balanceOf(a.address);
        await (await probe.connect(a).swapExactInLimit(poolAddr, WETH, amt, gradSqrt)).wait();
        const consumed = wBefore - (await wethW.balanceOf(a.address));
        totalIn += consumed;
        buys++;
        if (consumed === 0n) zeroBuys++; // price sitting at the ceiling: buy fills nothing, no revert
      } else {
        // sell a random fraction (25%..100%) of the bag
        const num = 25n + BigInt(Math.floor(rand() * 76));
        let amt = (bag * num) / 100n;
        if (amt === 0n) amt = bag;
        const poolWethBefore = await wethW.balanceOf(poolAddr);
        const wBefore = await wethW.balanceOf(a.address);
        // (3) NO SELL MAY REVERT — the whole point. Capture instead of throwing so we can report it.
        let reverted = false;
        try {
          await (await probe.connect(a).swapExactIn(poolAddr, token, amt)).wait();
        } catch (e) {
          reverted = true; sellReverts++;
          if (!firstSellRevert) firstSellRevert = `op#${i} actor sold ${amt} tokens: ${e.message}`;
        }
        expect(reverted, `SELL REVERTED at op#${i} — honeypot! ${firstSellRevert || ""}`).to.equal(false);
        const received = (await wethW.balanceOf(a.address)) - wBefore;
        totalOut += received;
        sells++;
        if (received === 0n) {
          zeroPayoutSells++;
          // a 0 payout is only acceptable if the pool was already drained to the floor
          expect(poolWethBefore, `op#${i}: sell paid 0 while pool still held WETH (${poolWethBefore}) — pool failed to pay a seller`)
            .to.be.lessThanOrEqual(DUST);
        }
      }

      // ── (1) CONSERVATION (exact) and (2) SOLVENCY, after every single op ──
      const poolWeth = await wethW.balanceOf(poolAddr);
      const expected = initialPoolWeth + totalIn - totalOut;
      const d = poolWeth > expected ? poolWeth - expected : expected - poolWeth;
      if (d > worstConservationDelta) worstConservationDelta = d;
      expect(poolWeth, `op#${i}: CONSERVATION broken — poolWeth ${poolWeth} != in-out ${expected}`).to.equal(expected);
      expect(totalOut, `op#${i}: SOLVENCY broken — out ${totalOut} > in ${totalIn}`).to.be.lessThanOrEqual(totalIn);
    }

    // curve must not have secretly graduated during the sim
    expect(await curveC.graduated(), "curve should still be pre-graduation").to.equal(false);

    const f = (x) => Number(ethers.formatEther(x));
    console.log("\n      ===== RANDOMIZED CONSERVATION SIM (real Uniswap v3 fork) =====");
    console.log(`      ops:                    ${N_OPS}   actors: ${N_ACTORS}`);
    console.log(`      buys / sells:           ${buys} / ${sells}   (forced-buys: ${forcedBuys})`);
    console.log(`      total ETH IN  (buys):   ${f(totalIn).toFixed(6)} ETH`);
    console.log(`      total ETH OUT (sells):  ${f(totalOut).toFixed(6)} ETH`);
    console.log(`      pool WETH now:          ${f(await wethW.balanceOf(poolAddr)).toFixed(6)} ETH (= in - out)`);
    console.log(`      net kept by pool/fees:  ${f(totalIn - totalOut).toFixed(6)} ETH  (out/in = ${totalIn > 0n ? (f(totalOut) / f(totalIn) * 100).toFixed(2) : "0"}%)`);
    console.log(`      SELL REVERTS:           ${sellReverts}   (must be 0)`);
    console.log(`      zero-payout sells:      ${zeroPayoutSells} (only when pool at floor)   zero-fill buys: ${zeroBuys} (at ceiling)`);
    console.log(`      worst conservation Δ:   ${worstConservationDelta} wei (must be 0)`);
    console.log("      ==============================================================\n");

    // final belt-and-suspenders
    expect(sellReverts, "no sell may ever revert").to.equal(0);
    expect(worstConservationDelta, "WETH conservation must be exact at every step").to.equal(0n);
    expect(totalOut, "solvency: total out <= total in").to.be.lessThanOrEqual(totalIn);
  });
});
