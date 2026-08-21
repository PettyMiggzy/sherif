const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { MAX_SQRT_LIMIT, E, f, buildLab, ledger, sizePush } = require("../helpers/h5-lab");

// [PROBE] Does the LIVE v3 Bond's pattern — conservative anchoring + a deviation guard, with the band placed
// relative to CURRENT price instead of frozen at launch — survive the attack that has broken seven v4 designs?
// The v3 fork test proved the pattern holds against a short shove. The open question is the SUSTAINED hold,
// where a real TWAP eventually follows the attacker. Modelled honestly: the mean tracks him.
describe("[PROBE] v3-style conservative anchoring vs the sustained hold", function () {
  this.timeout(0);
  const LAB = { baseL: 10n ** 20n, carve: E(20), dumpTick: 12000, hookTaxBps: 100 };

  async function run({ meanFollows, label }) {
    const snap = await takeSnapshot();
    const L = await buildLab({ ...LAB, vaultContract: "H5V3StyleVault" });
    const { sw, key, vault, tok, attacker, sqrtAt, stateView, poolId } = L;
    const led = ledger(attacker.address);
    const start = await ethers.provider.getBalance(attacker.address);
    const carve0 = await ethers.provider.getBalance(await vault.getAddress());

    // the honest mean starts at the true, dumped price
    const cur = async () => Number((await stateView.getSlot0(poolId))[1]);
    await vault.setMeanTick(await cur());

    // push the price up (tick DOWN) and HOLD it there
    const X = await sizePush(L, 59, 100);
    const t0 = await tok.balanceOf(attacker.address);
    await led.track(sw.connect(attacker).swap(
      key, { zeroForOne: true, amountSpecified: -X, sqrtPriceLimitX96: await sqrtAt(59) },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: X }
    ));
    const bought = (await tok.balanceOf(attacker.address)) - t0;

    let commits = 0;
    for (let i = 0; i < 12; i++) {
      await time.increase(3901);
      // a REAL TWAP would converge on a price held this long — model that, rather than assuming it away
      if (meanFollows) await vault.setMeanTick(await cur());
      const before = await vault.floorLiquidity();
      await led.track(vault.connect(attacker).addFloor());
      if ((await vault.floorLiquidity()) > before) commits++;
    }

    // release: sell back exactly what was bought, sweeping anything the vault minted
    await led.track(sw.connect(attacker).swap(
      key, { zeroForOne: false, amountSpecified: -bought, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    ));
    expect(await tok.balanceOf(attacker.address)).to.equal(t0); // token-flat
    const pnl = (await ethers.provider.getBalance(attacker.address)) - start + led.gas;
    const consumed = carve0 - (await ethers.provider.getBalance(await vault.getAddress()));
    console.log(`   ${label.padEnd(34)} attacker ${f(pnl).padStart(9)} ETH | ${commits} commits | carve consumed ${f(consumed)}/20`);
    await snap.restore();
    return { pnl, commits, consumed };
  }

  it("measures the sustained hold both ways", async () => {
    const stale = await run({ meanFollows: false, label: "mean stays honest (short shove)" });
    const follows = await run({ meanFollows: true, label: "mean FOLLOWS (sustained hold)" });
    // the honest, load-bearing question — does holding long enough for the TWAP to converge pay?
    console.log(`   => holding until the mean converges is worth ${f(follows.pnl - stale.pnl)} ETH to the attacker`);
    expect(stale.commits).to.equal(0); // a shove the guard rejects can never place a wall
  });
});
