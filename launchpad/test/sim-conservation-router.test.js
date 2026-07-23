const { expect } = require("chai");
const { ethers } = require("hardhat");

// ============================================================================
// RANDOMIZED CONSERVATION / SOLVENCY SIM through the REAL PadRouter (the "swap
// desk + fees" users actually hit) on a live Uniswap-v3 fork of Robinhood Chain.
// Many actors buy & sell ONE fresh coin in a long interleaved random sequence
// (hundreds of ops), with a real project tax so EVERY escrow bucket is exercised
// (platform immediate / deferred / platform-cut / dev / floor / burn).
//
// After EVERY op we assert:
//
//  (I)  CURVE CONSERVATION (exact, to the wei):
//         poolWeth == initialPoolWeth + Σ(WETH the pool actually took on buys)
//                                     - Σ(WETH the pool actually paid on sells)
//       reconstructed from the router's own Bought/Sold events (spent-fee = the
//       WETH consumed; ethOut+fee = the WETH paid out). Reward legs are OFF so
//       this reconstruction is exact. A mismatch = WETH leaking from the curve.
//
//  (II) CURVE SOLVENCY:  Σ(WETH paid out on sells) <= Σ(WETH taken in on buys).
//       Nobody can pull more WETH out of the curve than was put in.
//
//  (III) ROUTER ESCROW SOLVENCY (the "contract ETH balance == escrows" invariant):
//         router native-ETH balance == platformEscrow + platformCutEscrow
//                                     + deferredEscrow + devEscrow
//                                     + floorEscrow  + burnEscrow
//       The fee desk never owes more ETH than it holds; every wei of fee it has
//       skimmed is fully backed by ETH sitting in the contract. Also assert the
//       router never strands WETH (routerWETH == 0 between ops).
//
//  (IV) NO SELL EVER REVERTS (anti-honeypot). Every sell tx must succeed; while
//       the pool still holds WETH a sell must pay out > 0 (the pool can always
//       pay a seller). A 0-payout sell is tolerated ONLY once the curve has been
//       drained to its start-price floor (there is genuinely nothing left).
//
// Run: FORK_RPC=<rpc> npx hardhat test test/sim-conservation-router.test.js
// ============================================================================
const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// Production "let it ride" calibration from scripts/deploy.js
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

const N_OPS = 400;      // > "a few hundred"
const N_ACTORS = 6;
const DUST = 10n ** 9n; // 1 gwei: below this the pool counts as "drained to floor"

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

suite("Randomized conservation/solvency sim through PadRouter — buys+sells (fork)", function () {
  this.timeout(600000);

  it("curve conservation + router escrow solvency hold and no sell reverts across hundreds of ops", async () => {
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
    // reward vault deliberately LEFT UNSET: the 0.25% reward legs stay OFF so the
    // fee reconstruction below is exact. Fees (project + platform) are still on.

    const routerAddr = await router.getAddress();

    // launch a coin with a REAL project tax so every escrow bucket gets exercised:
    //   2% buy / 2% sell; project share split 80% wallet / 15% floor / 5% burn
    const TAX = { buyBps: 200, sellBps: 200, walletBps: 8000, floorBps: 1500, burnBps: 500, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "RSIM", symbol: "RSIM", dev: dev.address, tax: TAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;

    const curveC = await ethers.getContractAt("CurvePool", curve);
    const TOK = await ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], token);
    const wethW = await ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)"], WETH);

    const MAX = (1n << 250n);
    // ── fund every actor once: plenty of native ETH, and a max token approval to the router
    for (const a of actors) {
      await ethers.provider.send("hardhat_setBalance", [a.address, "0x" + (10n ** 24n).toString(16)]);
      await (await TOK.connect(a).approve(routerAddr, MAX)).wait();
    }

    // skip past the anti-snipe window so this is a normal live coin
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    const initialPoolWeth = await wethW.balanceOf(poolAddr); // single-sided seed => expected 0

    const escrowSum = async () =>
      (await router.platformEscrow()) +
      (await router.platformCutEscrow()) +
      (await router.deferredEscrow(token)) +
      (await router.devEscrow(token)) +
      (await router.floorEscrow(token)) +
      (await router.burnEscrow(token));

    // The router's deterministic CREATE address may already carry a pre-existing ETH balance in the
    // forked chain state (unrelated to any launchpad logic). Capture it as the baseline: escrows start
    // at 0, so from here on router ETH must equal baseline + Σ escrows exactly, forever.
    const baselineRouterEth = await ethers.provider.getBalance(routerAddr);
    expect(await escrowSum(), "escrows must start at 0").to.equal(0n);

    // event helpers (reconstruct exact WETH the CURVE took / paid, reward legs off)
    const findLog = (receipt, name) => {
      for (const l of receipt.logs) {
        try { const p = router.interface.parseLog(l); if (p && p.name === name) return p; } catch { /* not ours */ }
      }
      return null;
    };

    let totalNetIn = 0n;   // Σ WETH the pool actually took on buys (measured from events)
    let totalWethOut = 0n; // Σ WETH the pool actually paid on sells (measured from events)
    let buys = 0, sells = 0, zeroBuys = 0, zeroPayoutSells = 0, forcedBuys = 0;
    let sellReverts = 0, firstSellRevert = null;
    let worstConservationDelta = 0n, worstEscrowDelta = 0n;
    const rand = rng(0x5EED42);

    for (let i = 0; i < N_OPS; i++) {
      const a = actors[Math.floor(rand() * actors.length)];
      let doBuy = rand() < 0.5;
      const bag = await TOK.balanceOf(a.address);
      if (!doBuy && bag === 0n) { doBuy = true; forcedBuys++; } // can't sell what you don't hold

      if (doBuy) {
        const amt = (ONE / 100n) + BigInt(Math.floor(rand() * Number(ONE / 4n))); // 0.01 .. ~0.26 ETH
        const receipt = await (await router.connect(a).buy(token, 0n, { value: amt })).wait();
        const b = findLog(receipt, "Bought");
        // Bought(token, buyer, spent, fee, tokensOut); with reward legs off the WETH the
        // pool actually consumed == spent - fee (full fill: msg.value-fee; partial: consumed).
        const consumed = b.args.ethIn - b.args.fee;
        totalNetIn += consumed;
        buys++;
        if (consumed === 0n) zeroBuys++; // price sitting at the ceiling: buy fills nothing, full refund, no revert
      } else {
        // sell a random fraction (25%..100%) of the bag
        const num = 25n + BigInt(Math.floor(rand() * 76));
        let amt = (bag * num) / 100n;
        if (amt === 0n) amt = bag;
        const poolWethBefore = await wethW.balanceOf(poolAddr);
        // (IV) NO SELL MAY REVERT — the whole point. Capture instead of throwing so we can report it.
        let receipt = null, reverted = false;
        try {
          receipt = await (await router.connect(a).sell(token, amt, 0n)).wait();
        } catch (e) {
          reverted = true; sellReverts++;
          if (!firstSellRevert) firstSellRevert = `op#${i} sold ${amt} tokens: ${e.message}`;
        }
        expect(reverted, `SELL REVERTED at op#${i} — honeypot! ${firstSellRevert || ""}`).to.equal(false);
        const s = findLog(receipt, "Sold");
        // Sold(token, seller, tokensIn, fee, ethOut); WETH the pool paid == ethOut + fee (reward off)
        const wethOut = s.args.ethOut + s.args.fee;
        totalWethOut += wethOut;
        sells++;
        if (wethOut === 0n) {
          zeroPayoutSells++;
          // a 0 payout is only acceptable if the pool was already drained to the floor
          expect(poolWethBefore, `op#${i}: sell paid 0 while pool still held WETH (${poolWethBefore}) — pool failed to pay a seller`)
            .to.be.lessThanOrEqual(DUST);
        }
      }

      // ── invariants after EVERY single op ────────────────────────────────────
      const poolWeth = await wethW.balanceOf(poolAddr);
      const routerWeth = await wethW.balanceOf(routerAddr);
      const routerEth = await ethers.provider.getBalance(routerAddr);
      const escrows = await escrowSum();

      // (I) CURVE CONSERVATION (exact)
      const expPool = initialPoolWeth + totalNetIn - totalWethOut;
      const dC = poolWeth > expPool ? poolWeth - expPool : expPool - poolWeth;
      if (dC > worstConservationDelta) worstConservationDelta = dC;
      expect(poolWeth, `op#${i}: CURVE CONSERVATION broken — poolWeth ${poolWeth} != in-out ${expPool}`).to.equal(expPool);

      // (II) CURVE SOLVENCY
      expect(totalWethOut, `op#${i}: CURVE SOLVENCY broken — out ${totalWethOut} > in ${totalNetIn}`).to.be.lessThanOrEqual(totalNetIn);

      // (III) ROUTER ESCROW SOLVENCY: contract ETH balance == baseline + Σ escrows, and no stranded WETH.
      // (Solvency proper is routerEth >= escrows; we assert the exact tracking form, which is strictly stronger.)
      const backed = baselineRouterEth + escrows;
      const dE = routerEth > backed ? routerEth - backed : backed - routerEth;
      if (dE > worstEscrowDelta) worstEscrowDelta = dE;
      expect(routerEth, `op#${i}: ESCROW SOLVENCY broken — router ETH ${routerEth} != baseline+escrows ${backed}`).to.equal(backed);
      expect(routerWeth, `op#${i}: router stranded WETH ${routerWeth} (should be 0)`).to.equal(0n);
    }

    // curve must not have secretly graduated during the sim
    expect(await curveC.graduated(), "curve should still be pre-graduation").to.equal(false);

    const f = (x) => Number(ethers.formatEther(x));
    const finalEscrows = await escrowSum();
    console.log("\n      ===== RANDOMIZED CONSERVATION SIM via PadRouter (real Uniswap v3 fork) =====");
    console.log(`      ops:                    ${N_OPS}   actors: ${N_ACTORS}   tax: 2%/2% (80/15/5 wallet/floor/burn)`);
    console.log(`      buys / sells:           ${buys} / ${sells}   (forced-buys: ${forcedBuys})`);
    console.log(`      curve WETH IN  (buys):  ${f(totalNetIn).toFixed(6)} ETH`);
    console.log(`      curve WETH OUT (sells): ${f(totalWethOut).toFixed(6)} ETH`);
    console.log(`      pool WETH now:          ${f(await wethW.balanceOf(poolAddr)).toFixed(6)} ETH (= in - out)`);
    console.log(`      out/in on curve:        ${totalNetIn > 0n ? (f(totalWethOut) / f(totalNetIn) * 100).toFixed(2) : "0"}%  (<= 100% = solvent)`);
    console.log(`      router ETH == escrows:  ${f(await ethers.provider.getBalance(routerAddr)).toFixed(6)} == ${f(finalEscrows).toFixed(6)} ETH`);
    console.log(`      SELL REVERTS:           ${sellReverts}   (must be 0)`);
    console.log(`      zero-payout sells:      ${zeroPayoutSells} (only at floor)   zero-fill buys: ${zeroBuys} (at ceiling)`);
    console.log(`      worst curve   Δ:        ${worstConservationDelta} wei (must be 0)`);
    console.log(`      worst escrow  Δ:        ${worstEscrowDelta} wei (must be 0)`);
    console.log("      ===========================================================================\n");

    // final belt-and-suspenders
    expect(sellReverts, "no sell may ever revert").to.equal(0);
    expect(worstConservationDelta, "curve WETH conservation must be exact at every step").to.equal(0n);
    expect(worstEscrowDelta, "router escrow solvency must be exact at every step").to.equal(0n);
    expect(totalWethOut, "curve solvency: out <= in").to.be.lessThanOrEqual(totalNetIn);
  });
});
