const { expect } = require("chai");
const { ethers } = require("hardhat");

// Fork test — runs ONLY when FORK_RPC is set (forking Robinhood Chain mainnet), so the curve
// graduates into the REAL Uniswap v3 factory + WETH instead of the mock. This is the check the
// flat-price mock can't do: real pool creation, real tick-snapped full-range mint, real TWAP,
// and a real swap. Run: FORK_RPC=<rpc> npx hardhat test test/fork/graduation.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"; // verified Uniswap v3 factory (chainId 4663)
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";     // verified WETH

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("BondingCurve on a Robinhood Chain fork (real Uniswap v3)", function () {
  this.timeout(180000);

  it("graduates into the real v3 pool: prices + creates it, seeds & locks LP, arms TWAP, and trades", async () => {
    const [dep, platform, dev, trader] = await ethers.getSigners();

    // real graduation terms (80% curve slice of a 1B launch): VIRT 0.8 ETH, graduate at 4 ETH
    const SUPPLY = 800_000_000n * ONE;
    const VIRT = 8n * ONE / 10n;
    const GRAD = 4n * ONE;

    const TOK = await (await ethers.getContractFactory("CurveToken")).deploy("Sheriff Meme", "MEME", SUPPLY, dep.address);
    const curve = await (await ethers.getContractFactory("BondingCurve")).deploy(
      await TOK.getAddress(), WETH, FACTORY, platform.address, dev.address, VIRT, SUPPLY, GRAD, 0, 0
    );
    await (await TOK.connect(dep).transfer(await curve.getAddress(), SUPPLY)).wait();

    // (1) the constructor already created + initialized the REAL pool at the committed grad price
    const poolAddr = await curve.pool();
    expect(poolAddr).to.not.equal(ethers.ZeroAddress);
    const factory = await ethers.getContractAt("IUniswapV3Factory", FACTORY);
    expect(await factory.getPool(await TOK.getAddress(), WETH, 10000)).to.equal(poolAddr);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const slotBefore = await pool.slot0();
    expect(slotBefore.sqrtPriceX96).to.equal(await curve.gradSqrtPriceX96());
    expect(await pool.liquidity()).to.equal(0n); // priced but empty until graduation

    // (2) buy through the 4-ETH target -> auto-graduates, minting real LP into the locker
    await (await curve.connect(trader).buy(0, { value: 5n * ONE })).wait(); // caps at 4 ETH, refunds rest
    expect(await curve.graduated()).to.equal(true);

    // real liquidity now sits in the pool, priced exactly at the committed graduation price
    expect(await pool.liquidity()).to.be.greaterThan(0n);
    expect((await pool.slot0()).sqrtPriceX96).to.equal(await curve.gradSqrtPriceX96());
    const weth = await ethers.getContractAt("IERC20", WETH);
    const poolWeth = await weth.balanceOf(poolAddr);
    expect(poolWeth).to.be.greaterThan(3n * ONE); // ~4 ETH raised seeded as WETH

    // LP is held by the curve's locker (locked forever) and its fees route to the platform
    const locker = await ethers.getContractAt("LiquidityLocker", await curve.locker());
    expect(await locker.beneficiaryOf(poolAddr)).to.equal(platform.address);

    // TWAP is armed (cardinality grown) — observe() must succeed over a window
    await ethers.provider.send("evm_increaseTime", [60]);
    await ethers.provider.send("evm_mine", []);
    const obs = await pool.observe([60, 0]);
    expect(obs.tickCumulatives.length).to.equal(2);

    // unsold remainder was burned to dead (deflationary, continuous-price seeding)
    const dead = await TOK.balanceOf("0x000000000000000000000000000000000000dEaD");
    expect(dead).to.be.greaterThan(0n);

    // (3) a REAL swap trades against the graduated pool: buy the token with WETH
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
      WETH
    );
    await (await wethW.connect(trader).deposit({ value: ONE / 2n })).wait(); // wrap 0.5 ETH
    await (await wethW.connect(trader).approve(await probe.getAddress(), ONE / 2n)).wait();

    const tokBefore = await TOK.balanceOf(trader.address);
    await (await probe.connect(trader).swapExactIn(poolAddr, WETH, ONE / 2n)).wait();
    const tokGained = (await TOK.balanceOf(trader.address)) - tokBefore;
    expect(tokGained).to.be.greaterThan(0n); // the pool actually trades

    // price moved up after buying (sqrtPrice shifts in the token's favor)
    expect((await pool.slot0()).sqrtPriceX96).to.not.equal(await curve.gradSqrtPriceX96());
  });
});
