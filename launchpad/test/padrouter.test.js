const { expect } = require("chai");
const { ethers } = require("hardhat");

// Executable unit test of the PROJECT TAX math on a mock Uniswap v3 pool (no fork needed).
// Verifies: 4% caps, platform's fixed 25% cut, the project-share split (wallet/floor/burn), and payouts.
const ONE = 10n ** 18n;

describe("PadRouter — project tax split (mock pool)", function () {
  async function deploy() {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);
    const wethAddr = await weth.getAddress();
    const tokAddr = await token.getAddress();

    const [t0, t1] = tokAddr.toLowerCase() < wethAddr.toLowerCase() ? [tokAddr, wethAddr] : [wethAddr, tokAddr];
    const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(t0, t1, 10000);
    await (await pool.setWeth(wethAddr)).wait();
    await (await pool.setPrice(ONE)).wait(); // 1 token = 1 WETH, flat (no impact) for exact math
    const poolAddr = await pool.getAddress();

    // fund the pool with both sides so swaps can pay out
    await (await token.transfer(poolAddr, 500_000n * ONE)).wait();
    await (await weth.deposit({ value: 100n * ONE })).wait();
    await (await weth.transfer(poolAddr, 100n * ONE)).wait();

    const router = await (await ethers.getContractFactory("PadRouter")).deploy(wethAddr, platform.address);
    await (await router.connect(platform).setFactory(dep.address)).wait(); // deployer acts as the factory for registration
    return { dep, platform, dev, buyer, weth, token, tokAddr, pool, poolAddr, router };
  }

  it("enforces the 4% caps and a 100% allocation, and only the factory can register", async () => {
    const { dep, dev, token, tokAddr, poolAddr, router } = await deploy();
    const reg = (o) => router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address,
      o.buy, o.sell, o.w, o.f, o.b);
    await expect(reg({ buy: 401, sell: 0, w: 10000, f: 0, b: 0 })).to.be.revertedWithCustomError(router, "BadTax");
    await expect(reg({ buy: 0, sell: 401, w: 10000, f: 0, b: 0 })).to.be.revertedWithCustomError(router, "BadTax");
    await expect(reg({ buy: 100, sell: 100, w: 5000, f: 3000, b: 1000 })).to.be.revertedWithCustomError(router, "BadAlloc");
    await expect(router.connect(dev).register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 100, 100, 10000, 0, 0))
      .to.be.revertedWithCustomError(router, "OnlyFactory");
    // valid at exactly the cap
    await expect(reg({ buy: 400, sell: 400, w: 5000, f: 3000, b: 2000 })).to.not.be.reverted;
  });

  it("buy: platform gets 25%, project 75% split to wallet/floor/burn — to the exact wei", async () => {
    const { dep, platform, dev, buyer, token, tokAddr, poolAddr, router } = await deploy();
    // 4% buy tax; project split 50% wallet / 30% floor / 20% burn
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 400, 400, 5000, 3000, 2000)).wait();

    const spend = ONE; // 1 ETH
    const fee = (spend * 400n) / 10_000n; // 0.04
    const plat = (fee * 2500n) / 10_000n; // 0.01  (25% of the tax)
    const proj = fee - plat; // 0.03
    const devCut = (proj * 5000n) / 10_000n; // 0.015
    const burnCut = (proj * 2000n) / 10_000n; // 0.006
    const floorCut = proj - devCut - burnCut; // 0.009

    const out = await router.connect(buyer).buy.staticCall(tokAddr, 0, { value: spend });
    await (await router.connect(buyer).buy(tokAddr, 0, { value: spend })).wait();
    // net (0.96 ETH) bought at 1:1 => 0.96 tokens
    expect(out).to.equal(spend - fee);
    expect(await token.balanceOf(buyer.address)).to.equal(spend - fee);

    expect(await router.platformEscrow()).to.equal(plat);
    expect(await router.devEscrow(tokAddr)).to.equal(devCut);
    expect(await router.floorEscrow(tokAddr)).to.equal(floorCut);
    expect(await router.burnEscrow(tokAddr)).to.equal(burnCut);

    // ── payouts ──
    // platform share -> platform (the router owner)
    const pBefore = await ethers.provider.getBalance(platform.address);
    await (await router.connect(buyer).withdrawPlatform()).wait();
    expect(await ethers.provider.getBalance(platform.address)).to.equal(pBefore + plat);
    expect(await router.platformEscrow()).to.equal(0n);

    // dev share -> the configured project wallet
    const dBefore = await ethers.provider.getBalance(dev.address);
    await (await router.connect(buyer).withdrawDev(tokAddr)).wait();
    expect(await ethers.provider.getBalance(dev.address)).to.equal(dBefore + devCut);

    // burn share -> buys token, sends to dead
    const dead = "0x000000000000000000000000000000000000dEaD";
    await (await router.connect(buyer).flushBurn(tokAddr)).wait();
    expect(await router.burnEscrow(tokAddr)).to.equal(0n);
    expect(await token.balanceOf(dead)).to.equal(burnCut); // burnCut ETH -> burnCut tokens at 1:1
  });

  it("sell: seller gets ETH net of the sell tax, and the tax feeds the same escrows", async () => {
    const { dev, buyer, token, tokAddr, poolAddr, router } = await deploy();
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 0, 400, 5000, 3000, 2000)).wait();

    // give the seller tokens to sell
    await (await token.transfer(buyer.address, 10n * ONE)).wait();
    const sellAmt = 10n * ONE;
    await (await token.connect(buyer).approve(await router.getAddress(), sellAmt)).wait();

    const wethOut = sellAmt; // 1:1
    const fee = (wethOut * 400n) / 10_000n;
    const ethOut = wethOut - fee;

    const got = await router.connect(buyer).sell.staticCall(tokAddr, sellAmt, 0);
    expect(got).to.equal(ethOut);
    await (await router.connect(buyer).sell(tokAddr, sellAmt, 0)).wait();

    // sell tax split into escrows (platform 25%, project 75%)
    expect(await router.platformEscrow()).to.equal((fee * 2500n) / 10_000n);
    const proj = fee - (fee * 2500n) / 10_000n;
    expect(await router.devEscrow(tokAddr)).to.equal((proj * 5000n) / 10_000n);

    // slippage guard: asking more than the net reverts
    await (await token.transfer(buyer.address, ONE)).wait();
    await (await token.connect(buyer).approve(await router.getAddress(), ONE)).wait();
    await expect(router.connect(buyer).sell(tokAddr, ONE, ONE)).to.be.revertedWithCustomError(router, "Slippage");
  });
});
