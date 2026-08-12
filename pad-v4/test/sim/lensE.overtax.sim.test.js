const { ethers } = require("hardhat");
const { expect } = require("chai");

// LENS E probe — quantify the effective buy tax when a buy PARTIALLY FILLS against a price limit /
// the curve's liquidity ceiling. The buy tax is fee-on-the-REQUESTED-input; if the swap only fills a
// fraction of (input - fee), the buyer still pays 1% of the WHOLE requested input. We measure the
// effective tax on the ETH that actually swapped, for a realistic "graduating buy" that oversizes.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAGS = 0xccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(dep, h) {
  for (let i = 0n; ; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(dep, s, h);
    if ((BigInt(a) & MASK) === FLAGS) return { salt: s, addr: a };
  }
}
const idOf = (k) => ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));

describe("LENS E — partial-fill buy over-tax at a price boundary", () => {
  it("measures effective tax when a buy fills only a fraction of its requested input", async () => {
    const [owner, factory, platform, lp, trader, creator] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const th = await (await ethers.getContractFactory("TickHelper")).deploy();
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"], [await pm.getAddress(), factory.address, await reg.getAddress(), await tok.getAddress()])]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    const hook = HookF.attach(addr);

    // Emulate the single-sided curve geometry: liquidity only in [GRAD, START]; buys walk price DOWN to GRAD.
    const START = 6000, GRAD = 3000, TS = 60, FEE = 3000;
    const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: addr };
    const poolId = idOf(key);
    const startSqrt = await th.sqrt(START);
    await pm.initialize(key, startSqrt);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address, floorRecipient: ZERO,
      guardAdapter: ZERO, buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 0, quoteIsStock: false,
    });
    // single-sided token-only liquidity in [GRAD, START] (like the curve seed): NO eth needed. Sized shallow so the
    // whole curve holds only a few ETH (like the real ~4.1-ETH production curve), so a graduating buy meaningfully
    // partial-fills against the ceiling.
    const mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 25n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(key, { tickLower: GRAD, tickUpper: START, liquidityDelta: 10n ** 19n, salt: ethers.ZeroHash }, "0x");

    const gradSqrt = await th.sqrt(GRAD);
    async function spotTick() { return Number((await stateView.getSlot0(poolId))[1]); }

    // REALISTIC FLOW: the GRADUATING buy. Walk the shallow curve down toward the ceiling with small, fully-filling
    // buys (each well under remaining capacity, so no over-tax) until only a sliver of capacity remains. Then a
    // whale sends an OVERSIZED buy to grab the last of the curve — it partial-fills at the ceiling, but is taxed
    // 1% of its WHOLE requested input.
    const TARGET = GRAD + 40; // leave a sliver of capacity (~40 ticks ≈ 0.4%) above the ceiling
    let guard = 0;
    while ((await spotTick()) > TARGET && guard++ < 4000) {
      const t = await spotTick();
      // adaptive chunk: big far from the ceiling, tiny near it (price accelerates as capacity runs out)
      const chunk = t > GRAD + 800 ? "0.02" : t > GRAD + 200 ? "0.004" : "0.0006";
      try {
        await sw.connect(trader).swap(key, { zeroForOne: true, amountSpecified: -ethers.parseEther(chunk), sqrtPriceLimitX96: gradSqrt },
          { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(chunk) });
      } catch (e) { break; } // overshoot to the ceiling → stop
    }
    const limitSqrt = gradSqrt;
    const nearTick = await spotTick();
    expect(nearTick).to.be.gt(GRAD); // still a sliver of curve capacity remains

    // Now the curve has only a tiny bit of capacity left before GRAD. A whale sends an OVERSIZED graduating buy
    // (5 ETH) with the natural price limit at the ceiling (or MIN — same result, curve liquidity ends at GRAD).
    const claimBefore = await pm.balanceOf(addr, 0n);
    const wBefore = await ethers.provider.getBalance(trader.address);
    const tokBefore = await tok.balanceOf(trader.address);
    const req = ethers.parseEther("5");
    const rc = await (await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -req, sqrtPriceLimitX96: limitSqrt },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: req }
    )).wait();
    const spent = wBefore - (await ethers.provider.getBalance(trader.address)) - rc.gasUsed * rc.gasPrice; // net ETH out of pocket
    const feeClaim = (await pm.balanceOf(addr, 0n)) - claimBefore; // buy tax minted (on requested 5 ETH)
    const tokGot = (await tok.balanceOf(trader.address)) - tokBefore;
    const principalToPool = spent - feeClaim; // ETH that actually became "raise" (swapped into the pool)

    const reqEth = Number(req) / 1e18;
    const feeEth = Number(feeClaim) / 1e18;
    const principalEth = Number(principalToPool) / 1e18;
    const effTaxOnFilled = feeEth / (principalEth + feeEth) * 100; // tax as % of what the buyer actually spent-to-buy
    const effTaxVsValue = feeEth / principalEth * 100;             // tax as % of value actually received

    console.log(`      near-grad tick=${nearTick} (GRAD=${GRAD})`);
    console.log(`      requested=${reqEth} ETH | buy-tax minted=${feeEth.toFixed(5)} ETH (1% of REQUESTED)`);
    console.log(`      actually swapped into pool=${principalEth.toFixed(5)} ETH | token bought=${(Number(tokGot)/1e18).toFixed(0)}`);
    console.log(`      EFFECTIVE tax on the filled trade = ${effTaxOnFilled.toFixed(1)}%  (nominal is 1%)`);
    console.log(`      tax as % of value received        = ${effTaxVsValue.toFixed(1)}%`);

    // the fee is 1% of the REQUESTED 5 ETH regardless of how little filled
    expect(feeClaim).to.equal(req * 100n / 10000n);
    // the buyer got grossly over-taxed relative to what actually swapped
    expect(effTaxOnFilled).to.be.gt(5); // >> the nominal 1%
  });
});
