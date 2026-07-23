// Per-function sim: LaunchToken._update transfer guard. Proves the operator's #1 invariant — SELLS ARE NEVER
// BLOCKED — plus buy-side anti-snipe caps that auto-expire and never touch sells or ordinary transfers.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("LaunchToken guard — sells never blocked; buy-side anti-snipe only", function () {
  this.timeout(240000);

  it("caps a buy over the per-wallet limit in the window, always allows sells, and uncaps after 300s", async () => {
    const [dep, platform, dev, buyer, seller] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH);
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Guard", symbol: "GRD", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token } = ev.args;
    const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"], token);
    for (const w of [buyer, seller]) await ethers.provider.send("hardhat_setBalance", [w.address, "0x" + (10n ** 24n).toString(16)]);

    // into the phase-2 anti-snipe window (60s..300s): caps are ~1% per tx / 2% per wallet, no phase-1 cooldown
    await ethers.provider.send("evm_increaseTime", [90]);
    await ethers.provider.send("evm_mine", []);

    // 1) an oversized buy (way past the ~2% per-wallet anti-snipe cap) must REVERT
    let oversizedReverted = false;
    try { await (await router.connect(buyer).buy(token, 0, { value: 40n * ONE })).wait(); }
    catch { oversizedReverted = true; }
    expect(oversizedReverted, "an oversized buy should hit the anti-snipe cap").to.equal(true);

    // 2) a small in-cap buy succeeds (well under the ~1% per-tx / 2% per-wallet anti-snipe caps: 0.01 ETH ≈ 5M tokens)
    await (await router.connect(seller).buy(token, 0, { value: ethers.parseEther("0.01") })).wait();
    const sellerBag = await TOK.balanceOf(seller.address);
    expect(sellerBag, "small in-cap buy should deliver tokens").to.be.greaterThan(0n);

    // 3) THE INVARIANT: selling DURING the anti-snipe window is never blocked
    await (await TOK.connect(seller).approve(await router.getAddress(), sellerBag)).wait();
    const preEth = await ethers.provider.getBalance(seller.address);
    const sr = await (await router.connect(seller).sell(token, sellerBag, 0)).wait();
    const gotEth = (await ethers.provider.getBalance(seller.address)) - preEth + sr.gasUsed * sr.gasPrice;
    expect(gotEth, "sell in the anti-snipe window must pay out (no honeypot)").to.be.greaterThan(0n);

    // 4) ordinary wallet->wallet transfer of a dust amount is never restricted
    await (await router.connect(buyer).buy(token, 0, { value: ethers.parseEther("0.01") })).wait();
    const some = (await TOK.balanceOf(buyer.address)) / 4n;
    await (await TOK.connect(buyer).transfer(dev.address, some)).wait(); // must not revert
    expect(await TOK.balanceOf(dev.address)).to.be.greaterThan(0n);

    // 5) after the 300s anti-snipe window, the same oversized buy now SUCCEEDS (cap auto-expired)
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);
    await (await router.connect(buyer).buy(token, 0, { value: 40n * ONE })).wait(); // no revert
    expect(await TOK.balanceOf(buyer.address), "post-window big buy delivers a large bag").to.be.greaterThan(sellerBag);
  });
});
