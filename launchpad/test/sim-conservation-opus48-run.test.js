const { expect } = require("chai");
const { ethers } = require("hardhat");

// ============================================================================
// RANDOMIZED CONSERVATION / SOLVENCY SIM (real Uniswap v3 fork of Robinhood Chain)
//
// Independent re-derivation of the operator's core safety question. Many actors
// buy & sell ONE fresh coin in a long, randomized, interleaved sequence
// (hundreds of ops, random amounts). After EVERY op we assert:
//
//   INV-1  SOLVENCY / "no more out than in": the pool never owes more ETH than it
//          holds. Measured flows: Σsells <= Σbuys, and the pool's live WETH balance
//          equals exactly (raised WETH held in the curve/pool) = Σbuys - Σsells.
//          There are NO escrows during the trading phase (creator/platform/floor
//          escrows only exist AFTER graduation), so during the sim:
//              contractEthHeld (pool WETH) == raised == Σbuys - Σsells   (to the wei)
//          A drift here means WETH is leaking or being minted from nothing.
//
//   INV-2  NO SELL EVER REVERTS (anti-honeypot). Every sell tx must succeed. While
//          the pool still holds WETH, every sell must pay out > 0 (the pool can
//          always pay a seller). A 0-payout sell is tolerated ONLY when the pool is
//          drained to the curve floor (nothing left to hand back — still not a revert).
//
// Trades hit the RAW Uniswap v3 pool directly via SwapProbe (bypassing PadRouter),
// so this is the strongest possible statement about the underlying bonding curve.
//
// Run: FORK_RPC=<rpc> npx hardhat test test/sim-conservation-opus48-run.test.js
// ============================================================================
const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// Production "let it ride" calibration from scripts/deploy.js
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

const N_OPS = 420;      // > "a few hundred"
const N_ACTORS = 10;    // independent traders
const DUST = 10n ** 9n; // 1 gwei: below this the pool is "drained to floor"

// deterministic PRNG (mulberry32) so any failure is reproducible
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

suite("Conservation/solvency sim (opus48-run) — interleaved random buys+sells, real v3 fork", function () {
  this.timeout(900000);

  it("solvency holds every step and no sell ever reverts across 420 random ops", async () => {
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
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    );
    await (await router.setFactory(await factory.getAddress())).wait();

    // launch a plain 1% (no project tax) coin
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "SIMR", symbol: "SIMR", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;

    const curveC = await ethers.getContractAt("CurvePool", curve);
    const TOK = await ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], token);
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const gradSqrt = await curveC.gradSqrtPriceX96(); // cap buys at the ceiling; never run into empty space
    const MAX = (1n << 250n);

    // ── fund every actor once: ETH -> lots of WETH, max approvals ────────────
    for (const a of actors) {
      await ethers.provider.send("hardhat_setBalance", [a.address, "0x" + (10n ** 24n).toString(16)]);
      await (await wethW.connect(a).deposit({ value: 50n * ONE })).wait();
      await (await wethW.connect(a).approve(probeAddr, MAX)).wait();
      await (await TOK.connect(a).approve(probeAddr, MAX)).wait();
    }

    // skip the anti-snipe window so this is a normal live coin
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // Pre-trade the pool holds no WETH (single-sided seed). This is the "raised" baseline.
    const initialPoolWeth = await wethW.balanceOf(poolAddr);
    expect(initialPoolWeth, "single-sided seed should hold 0 WETH before trading").to.equal(0n);

    let totalIn = 0n;    // Σ WETH consumed by buys (measured, incl. any pool fee)
    let totalOut = 0n;   // Σ WETH received by sells (measured)
    let buys = 0, sells = 0, zeroBuys = 0, zeroPayoutSells = 0, forcedBuys = 0;
    let sellReverts = 0, firstSellRevert = null;
    let worstConsvDelta = 0n;
    let minPoolWeth = null, maxPoolWeth = 0n;
    const rand = rng(0x5EED2026);

    for (let i = 0; i < N_OPS; i++) {
      const a = actors[Math.floor(rand() * actors.length)];
      let doBuy = rand() < 0.5;
      const bag = await TOK.balanceOf(a.address);
      if (!doBuy && bag === 0n) { doBuy = true; forcedBuys++; } // can't sell what you don't hold

      if (doBuy) {
        // 0.01 .. ~0.26 ETH per buy
        const amt = (ONE / 100n) + BigInt(Math.floor(rand() * Number(ONE / 4n)));
        const wBefore = await wethW.balanceOf(a.address);
        await (await probe.connect(a).swapExactInLimit(poolAddr, WETH, amt, gradSqrt)).wait();
        const consumed = wBefore - (await wethW.balanceOf(a.address));
        totalIn += consumed;
        buys++;
        if (consumed === 0n) zeroBuys++; // price sitting at ceiling: buy fills nothing, no revert
      } else {
        // sell a random fraction (20%..100%) of the bag
        const num = 20n + BigInt(Math.floor(rand() * 81));
        let amt = (bag * num) / 100n;
        if (amt === 0n) amt = bag;
        const poolWethBefore = await wethW.balanceOf(poolAddr);
        const wBefore = await wethW.balanceOf(a.address);

        // INV-2: the sell must not revert. Capture instead of throwing so we can report the op#.
        let reverted = false;
        try {
          await (await probe.connect(a).swapExactIn(poolAddr, token, amt)).wait();
        } catch (e) {
          reverted = true; sellReverts++;
          if (!firstSellRevert) firstSellRevert = `op#${i}: sell ${amt} tok reverted: ${e.message}`;
        }
        expect(reverted, `SELL REVERTED at op#${i} — HONEYPOT. ${firstSellRevert || ""}`).to.equal(false);

        const received = (await wethW.balanceOf(a.address)) - wBefore;
        totalOut += received;
        sells++;
        if (received === 0n) {
          zeroPayoutSells++;
          // a 0 payout is acceptable ONLY if the pool was already drained to the floor
          expect(poolWethBefore, `op#${i}: sell paid 0 while pool held ${poolWethBefore} WETH — pool failed to pay a seller`)
            .to.be.lessThanOrEqual(DUST);
        }
      }

      // ── INV-1: exact solvency/conservation after EVERY op ──────────────────
      const poolWeth = await wethW.balanceOf(poolAddr);
      const raisedExpected = initialPoolWeth + totalIn - totalOut;
      const d = poolWeth > raisedExpected ? poolWeth - raisedExpected : raisedExpected - poolWeth;
      if (d > worstConsvDelta) worstConsvDelta = d;
      if (minPoolWeth === null || poolWeth < minPoolWeth) minPoolWeth = poolWeth;
      if (poolWeth > maxPoolWeth) maxPoolWeth = poolWeth;
      // contract ETH held == raised (no escrows pre-graduation) == Σin - Σout, to the wei
      expect(poolWeth, `op#${i}: SOLVENCY/CONSERVATION broken — pool holds ${poolWeth} != raised ${raisedExpected}`).to.equal(raisedExpected);
      // pool can never owe more than it holds
      expect(totalOut, `op#${i}: SOLVENCY broken — total out ${totalOut} > total in ${totalIn}`).to.be.lessThanOrEqual(totalIn);
      // and the balance itself is never negative-implied
      expect(poolWeth >= 0n, `op#${i}: pool WETH negative`).to.equal(true);
    }

    // must not have secretly graduated mid-sim (would change the accounting model)
    expect(await curveC.graduated(), "curve should still be pre-graduation").to.equal(false);

    const f = (x) => Number(ethers.formatEther(x));
    const finalPool = await wethW.balanceOf(poolAddr);
    console.log("\n      ===== CONSERVATION SIM opus48-run (real Uniswap v3 fork) =====");
    console.log(`      ops:                    ${N_OPS}   actors: ${N_ACTORS}`);
    console.log(`      buys / sells:           ${buys} / ${sells}   (forced-buys: ${forcedBuys})`);
    console.log(`      total ETH IN  (buys):   ${f(totalIn).toFixed(6)} ETH`);
    console.log(`      total ETH OUT (sells):  ${f(totalOut).toFixed(6)} ETH`);
    console.log(`      pool WETH / raised now: ${f(finalPool).toFixed(6)} ETH (= in - out)`);
    console.log(`      pool WETH range:        ${f(minPoolWeth || 0n).toFixed(6)} .. ${f(maxPoolWeth).toFixed(6)} ETH`);
    console.log(`      net kept by pool:       ${f(totalIn - totalOut).toFixed(6)} ETH  (out/in = ${totalIn > 0n ? (f(totalOut) / f(totalIn) * 100).toFixed(2) : "0"}%)`);
    console.log(`      SELL REVERTS:           ${sellReverts}   (must be 0)`);
    console.log(`      zero-payout sells:      ${zeroPayoutSells} (only at floor)   zero-fill buys: ${zeroBuys} (at ceiling)`);
    console.log(`      worst conservation Δ:   ${worstConsvDelta} wei (must be 0)`);
    console.log("      ==============================================================\n");

    // belt-and-suspenders finals
    expect(sellReverts, "no sell may ever revert").to.equal(0);
    expect(worstConsvDelta, "WETH conservation must be exact at every step").to.equal(0n);
    expect(totalOut, "solvency: total out <= total in").to.be.lessThanOrEqual(totalIn);
    expect(finalPool, "final pool WETH must equal net raised").to.equal(totalIn - totalOut);
  });
});
