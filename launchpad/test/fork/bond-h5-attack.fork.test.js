const { expect } = require("chai");
const { ethers } = require("hardhat");

// [H-5 vs the LIVE v3 Bond] The attack that drains the v4 RobinFloorVault, aimed at the SHIPPED v3 Bond.
//
// v4's floor decides WHETHER to commit parked ETH into a FIXED band, gated on how long the price has been low.
// That gate is unwinnable: holding a price costs nothing per unit time, so a manipulated price and a real crash
// are the same observation. Seven designs have failed on it.
//
// The v3 Bond never asks that question. On every poke it RE-PLACES its walls, anchoring each to the
// CONSERVATIVE side of {spot, 15s TWAP} — `belowAnchor = min(spot, mean)`, `aboveAnchor = max(spot, mean)` —
// and refuses outright if spot is more than MAX_DEV (300 ticks, ~3%) from the mean. If that works, pushing the
// price in EITHER direction is worthless: push the way that would help you and the anchor falls back to the
// honest mean; push far enough to matter and the poke reverts.
//
// This test tries to profit from a poke, both directions, with a no-Bond control.
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
function bigSqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
function initSqrtPrice(tokenAddr, tokPerWeth) {
  const tokenIsToken0 = BigInt(tokenAddr) < BigInt(WETH);
  const weth = ONE, tok = tokPerWeth * ONE;
  const [a0, a1] = tokenIsToken0 ? [tok, weth] : [weth, tok];
  return bigSqrt((a1 * (1n << 192n)) / a0);
}
const f = (x, d = 6) => Number(ethers.formatEther(x)).toFixed(d);
const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("[H-5] the live v3 Bond under the attack that drains the v4 floor", function () {
  this.timeout(600000);

  async function build({ withBond }) {
    const [dep, platform, curveSigner, attacker] = await ethers.getSigners();
    const SUPPLY = 1_000_000_000n * ONE;
    const TOK = await (await ethers.getContractFactory("CurveToken")).deploy("Bonded", "BOND", SUPPLY, dep.address);
    const tokAddr = await TOK.getAddress();
    const factory = await ethers.getContractAt("IUniswapV3Factory", FACTORY);
    await (await factory.createPool(tokAddr, WETH, 10000)).wait();
    const poolAddr = await factory.getPool(tokAddr, WETH, 10000);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    await (await pool.initialize(initSqrtPrice(tokAddr, 50_000_000n))).wait();
    await (await pool.increaseObservationCardinalityNext(20)).wait();

    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], WETH);
    const bond = await (await ethers.getContractFactory("Bond")).deploy(tokAddr, WETH, FACTORY, platform.address, curveSigner.address);
    const bondAddr = await bond.getAddress();
    const keepWeth = ONE / 2n, moatWeth = ONE / 2n;
    const keepTokens = 25_000_000n * ONE, rampTokens = 250_000_000n * ONE;
    await (await wethW.connect(dep).deposit({ value: keepWeth + moatWeth })).wait();
    await (await wethW.connect(dep).transfer(bondAddr, keepWeth + moatWeth)).wait();
    await (await TOK.connect(dep).transfer(bondAddr, keepTokens + rampTokens)).wait();
    if (withBond) await (await bond.connect(curveSigner).post(keepWeth, keepTokens, moatWeth, rampTokens)).wait();
    else {
      // CONTROL: same pool depth, but as a plain full-range LP with NO Bounty wall to attack.
      await (await bond.connect(curveSigner).post(keepWeth + moatWeth - 1n, keepTokens + rampTokens - 1n, 1n, 1n)).wait();
    }

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const swap = async (signer, tokenIn, amount) => {
      if (tokenIn === WETH) await (await wethW.connect(signer).approve(probeAddr, amount)).wait();
      else await (await TOK.connect(signer).approve(probeAddr, amount)).wait();
      await (await probe.connect(signer).swapExactIn(poolAddr, tokenIn, amount)).wait();
    };
    const warp = async (s) => { await ethers.provider.send("evm_increaseTime", [s]); await ethers.provider.send("evm_mine", []); };
    await (await TOK.connect(dep).transfer(attacker.address, 400_000_000n * ONE)).wait();
    await (await wethW.connect(attacker).deposit({ value: 3n * ONE })).wait();
    return { TOK, tokAddr, pool, wethW, bond, swap, warp, attacker, dep };
  }

  // One round trip, EXACTLY token-flat: spend W WETH to buy token, poke at the shoved price, then sell back
  // precisely the tokens bought. Ending flat means the entire result is the WETH delta — no valuation needed.
  async function roundTrip(L, { pushWeth, poke }) {
    const { TOK, tokAddr, wethW, bond, swap, warp, attacker } = L;
    await warp(1000); // start calm so a poke is allowed at all
    const w0 = await wethW.balanceOf(attacker.address);
    const t0 = await TOK.balanceOf(attacker.address);

    await swap(attacker, WETH, pushWeth); // leg 1 — shove the price by buying token
    const bought = (await TOK.balanceOf(attacker.address)) - t0;

    let pokeLanded = false, why = null;
    if (poke) { try { await (await bond.poke()).wait(); pokeLanded = true; } catch (e) { why = (e.shortMessage || e.message); } }

    await swap(attacker, tokAddr, bought); // leg 2 — sell back EXACTLY what was bought
    const drift = (await TOK.balanceOf(attacker.address)) - t0;
    if (drift !== 0n) throw new Error("not token-flat: " + drift);
    return { pnl: (await wethW.balanceOf(attacker.address)) - w0, pokeLanded, why };
  }

  it("cannot be profited from, at any shove size the guard allows", async () => {
    // Sweep the shove size. Small shoves stay inside MAX_DEV so the poke LANDS — those are the ones that
    // matter, because a poke that reverts cannot be exploited by definition. Large shoves must be refused.
    const sizes = [["0.0002 WETH", ONE / 5000n], ["0.001 WETH", ONE / 1000n], ["0.005 WETH", ONE / 200n], ["0.02 WETH", ONE / 50n], ["1.00 WETH", ONE]];
    const rows = [];
    for (const [label, amt] of sizes) {
      const A = await build({ withBond: true });
      const withPoke = await roundTrip(A, { pushWeth: amt, poke: true });
      const B = await build({ withBond: true });
      const noPoke = await roundTrip(B, { pushWeth: amt, poke: false });
      const edge = withPoke.pnl - noPoke.pnl; // what poking at the shoved price was WORTH
      rows.push({ label, withPoke, noPoke, edge });
      console.log(`   shove ${label.padEnd(10)} poke ${withPoke.pokeLanded ? "LANDED " : "REFUSED"} | attacker ${f(withPoke.pnl)} | same trip w/o poke ${f(noPoke.pnl)} | edge from poking ${f(edge)}`);
    }

    // A poke that LANDS must give the attacker no edge over the identical round trip without one.
    for (const r of rows) {
      if (r.withPoke.pokeLanded) expect(r.edge, `shove ${r.label} paid off`).to.be.lte(0n);
      expect(r.withPoke.pnl, `shove ${r.label} profitable outright`).to.be.lt(0n);
    }
    const anyLanded = rows.some((r) => r.withPoke.pokeLanded);
    const anyRefused = rows.some((r) => !r.withPoke.pokeLanded);
    console.log(`   -> a poke LANDED on at least one shove: ${anyLanded}; REFUSED on the large ones: ${anyRefused}`);
    expect(anyRefused, "the deviation guard must refuse a big shove").to.equal(true);
  });
});
