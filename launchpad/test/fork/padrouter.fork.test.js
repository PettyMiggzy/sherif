const { expect } = require("chai");
const { ethers } = require("hardhat");

// The project tax, enforced at the PadRouter swap desk, against real Uniswap v3 on Robinhood Chain.
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/padrouter.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const SUPPLY = 1_000_000_000n * ONE;

const suite = process.env.FORK_RPC ? describe : describe.skip;

async function stack(dep, platform) {
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress()
  );
  await (await router.setFactory(await factory.getAddress())).wait();
  return { router, factory };
}

suite("PadRouter — the project tax (swap desk, 4% cap, platform 25%)", function () {
  this.timeout(240000);

  it("registration enforces the 4% caps and a 100% project-share allocation", async () => {
    const [dep, platform, dev] = await ethers.getSigners();
    const { factory } = await stack(dep, platform);
    const base = { name: "X", symbol: "X", dev: dev.address };

    // buy tax over 4% -> revert
    await expect(factory.launch({ ...base,
      tax: { buyBps: 401, sellBps: 0, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address } }))
      .to.be.reverted;
    // allocation that doesn't sum to 100% -> revert
    await expect(factory.launch({ ...base,
      tax: { buyBps: 100, sellBps: 100, walletBps: 5000, floorBps: 3000, burnBps: 1000, projectWallet: dev.address } }))
      .to.be.reverted;
  });

  it("splits a buy/sell tax: platform 25%, project 75% across wallet / floor / burn — and pays out", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const { router, factory } = await stack(dep, platform);

    // 3% buy, 3% sell; project 75% split 50% wallet / 30% floor / 20% burn
    const tax = { buyBps: 300, sellBps: 300, walletBps: 5000, floorBps: 3000, burnBps: 2000, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Taxed", symbol: "TAX", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token } = ev.args;
    const TOK = await ethers.getContractAt("LaunchToken", token);
    const routerAddr = await router.getAddress();

    // past the opening anti-snipe window
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);
    expect(await TOK.antiSnipeActive()).to.equal(false);

    // ===== BUY through the router (native ETH, no approval) =====
    const spend = ONE; // 1 ETH
    const fee = (spend * 300n) / 10_000n; // 3%
    const platCut = (fee * 2500n) / 10_000n; // 25% of the tax
    const proj = fee - platCut;
    const devCut = (proj * 5000n) / 10_000n;
    const burnCut = (proj * 2000n) / 10_000n;
    const floorCut = proj - devCut - burnCut;

    const t0 = await TOK.balanceOf(buyer.address);
    await (await router.connect(buyer).buy(token, 0, { value: spend })).wait();
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t0); // got tokens

    // the fee split landed in escrow, to the exact bps
    expect(await router.platformEscrow()).to.equal(platCut);
    expect(await router.devEscrow(token)).to.equal(devCut);
    expect(await router.floorEscrow(token)).to.equal(floorCut);
    expect(await router.burnEscrow(token)).to.equal(burnCut);

    // ===== payouts =====
    // dev share -> the project wallet (anyone may trigger; funds only go to the configured wallet)
    const devBefore = await ethers.provider.getBalance(dev.address);
    await (await router.connect(buyer).withdrawDev(token)).wait();
    expect(await ethers.provider.getBalance(dev.address)).to.equal(devBefore + devCut);
    expect(await router.devEscrow(token)).to.equal(0n);

    // platform share -> the platform (owner)
    const platBefore = await ethers.provider.getBalance(platform.address);
    // owner() is dep, but withdrawPlatform sends to owner(); set platform as owner? owner is dep here.
    // withdrawPlatform pays owner() == dep; just assert escrow clears and dep is paid.
    const depBefore = await ethers.provider.getBalance(dep.address);
    const wr = await (await router.connect(buyer).withdrawPlatform()).wait();
    expect(await router.platformEscrow()).to.equal(0n);
    expect(await ethers.provider.getBalance(dep.address)).to.equal(depBefore + platCut);
    platBefore; platCut; // (platform recipient is owner() by design)

    // burn share -> buys the token and sends it to dead
    const deadBefore = await TOK.balanceOf("0x000000000000000000000000000000000000dEaD");
    await (await router.connect(buyer).flushBurn(token)).wait();
    expect(await router.burnEscrow(token)).to.equal(0n);
    expect(await TOK.balanceOf("0x000000000000000000000000000000000000dEaD")).to.be.greaterThan(deadBefore);

    // ===== SELL through the router (one exact-amount approval) =====
    const bal = await TOK.balanceOf(buyer.address);
    const sellAmt = bal / 2n;
    await (await TOK.connect(buyer).approve(routerAddr, sellAmt)).wait();
    const ethBefore = await ethers.provider.getBalance(buyer.address);
    const floorBefore = await router.floorEscrow(token);
    const sr = await (await router.connect(buyer).sell(token, sellAmt, 0)).wait();
    // seller received native ETH (net of gas), and the sell tax grew the escrows
    const gas = sr.gasUsed * sr.gasPrice;
    expect(await ethers.provider.getBalance(buyer.address)).to.be.greaterThan(ethBefore - gas);
    expect(await router.floorEscrow(token)).to.be.greaterThan(floorBefore); // sell fee added to the floor share
  });
});
