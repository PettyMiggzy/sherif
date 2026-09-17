const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mineFor } = require("./helpers/brand");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

// DailyAuctionVault — the optional 0-4 day daily-tranche auction (see /home/user/sherif/V3-AUCTION-SPEC.md).
// Real @uniswap/v3-core bytecode, same pattern as poolsquat.test.js / creation-fee-and-pool-fee.test.js — the
// burn-and-buy on a closed day is a REAL swap against a REAL curve position, not a mocked accounting entry.

const START = 201600, WIDTH = 23000, MINGRAD = 22800;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const CREATION_FEE = ethers.parseEther("0.001");
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DAY = 24 * 3600;

describe("DailyAuctionVault — optional daily-tranche pre-launch auction", function () {
  this.timeout(300000);

  let dep, platform, dev, alice, bob, weth, v3, factory, router;

  const NOTAX = () => ({ buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address });

  before(async () => {
    [dep, platform, dev, alice, bob] = (await ethers.getSigners()).slice(-5);
    const at = async (n, ...a) => (await ethers.getContractFactory(n)).connect(dep).deploy(...a).then((c) => c.getAddress());
    weth = await at("MockWETH9");
    v3 = await new ethers.ContractFactory(V3_FACTORY_ART.abi, V3_FACTORY_ART.bytecode, dep).deploy().then((c) => c.getAddress());
    const ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    router = await at("PadRouter", weth, dep.address);
    factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd, ethers.ZeroAddress, START, WIDTH, MINGRAD
    );
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(await factory.getAddress())).wait();

    const rsd = await at("RobinStakingDeployer");
    const davd = await at("DailyAuctionVaultDeployer", rsd);
    await (await factory.connect(dep).setAuctionVaultDeployer(davd)).wait();
  });

  const launched = (rc) => rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Launched");

  async function launchWithAuction(tag, auctionDays) {
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: tag, symbol: tag.toUpperCase() }, 0n, `auction-${tag}`);
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: tag, symbol: tag.toUpperCase(), dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays },
      salt, { value: CREATION_FEE }
    )).wait();
    const ev = launched(rc);
    expect(ev.args.auctionVault).to.not.equal(ethers.ZeroAddress);
    expect(await factory.auctionVaultOf(token)).to.equal(ev.args.auctionVault);
    const vault = await ethers.getContractAt("DailyAuctionVault", ev.args.auctionVault);
    return { token, curve: ev.args.curve, pool: ev.args.pool, vault };
  }

  it("auctionDays: 0 launches with NO vault — unchanged legacy behavior", async () => {
    const { salt, addr: token } = await mineFor(factory, dev.address, { name: "NoAuction", symbol: "NOAUC" }, 0n, "auction-none");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "NoAuction", symbol: "NOAUC", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 },
      salt, { value: CREATION_FEE }
    )).wait();
    const ev = launched(rc);
    expect(ev.args.auctionVault).to.equal(ethers.ZeroAddress);
    expect(await factory.auctionVaultOf(token)).to.equal(ethers.ZeroAddress);
  });

  it("auctionDays > 0 without setAuctionVaultDeployer reverts BadValue (feature off by default)", async () => {
    const freshRouter = await (await ethers.getContractFactory("PadRouter")).connect(dep).deploy(weth, dep.address).then((c) => c.getAddress());
    const ltd2 = await (await ethers.getContractFactory("LaunchTokenDeployer")).connect(dep).deploy().then((c) => c.getAddress());
    const cpd2 = await (await ethers.getContractFactory("CurvePoolDeployer")).connect(dep).deploy().then((c) => c.getAddress());
    const bd2 = await (await ethers.getContractFactory("BondDeployer")).connect(dep).deploy(9000, 15600).then((c) => c.getAddress());
    const freshFactory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, freshRouter, ltd2, cpd2, bd2, ethers.ZeroAddress, START, WIDTH, MINGRAD
    );
    await (await (await ethers.getContractAt("PadRouter", freshRouter)).connect(dep).setFactory(await freshFactory.getAddress())).wait();
    const { salt } = await mineFor(freshFactory, dev.address, { name: "Off", symbol: "OFF" }, 0n, "auction-feature-off");
    await expect(
      freshFactory.connect(dev).launchWithSalt(
        { name: "Off", symbol: "OFF", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 1 },
        salt, { value: CREATION_FEE }
      )
    ).to.be.revertedWithCustomError(freshFactory, "BadValue");
  });

  it("carves exactly auctionDays*10% of the curve's share into the vault; curve seeds with the rest", async () => {
    const { token, curve, vault } = await launchWithAuction("Carve", 2);
    const TOK = await ethers.getContractAt("LaunchToken", token);
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const curveSupply = await curveC.curveSupply();
    const ambushSupply = await curveC.ambushSupply();
    const vaultBal = await TOK.balanceOf(await vault.getAddress());
    // total supply accounted for exactly, nothing stranded in the factory
    expect(await TOK.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(curveSupply + ambushSupply + vaultBal).to.equal(SUPPLY);
    expect(await vault.dayTranche()).to.equal(vaultBal / 2n);
    // dayTranche is 10% of the ORIGINAL (pre-carve) curve share regardless of auctionDays chosen — confirm
    // against a 1-day auction on an identical launch shape landing on the SAME per-day tranche size.
    const { vault: vault1 } = await launchWithAuction("CarveOne", 1);
    expect(await vault1.dayTranche()).to.equal(await vault.dayTranche());
  });

  it("bidding outside a day's window reverts; bidding inside it accrues correctly for multiple bidders", async () => {
    const { vault } = await launchWithAuction("BidWindow", 2);
    await expect(vault.connect(alice).bid(2, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(vault, "WindowNotOpen");
    await expect(vault.connect(alice).bid(3, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(vault, "BadDay");
    await expect(vault.connect(alice).bid(1, { value: 0 })).to.be.revertedWithCustomError(vault, "Zero");

    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });
    await vault.connect(bob).bid(1, { value: ethers.parseEther("3") });
    // additive: alice bids again on the same day
    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });
    expect(await vault.bidOf(1, alice.address)).to.equal(ethers.parseEther("2"));
    expect(await vault.bidOf(1, bob.address)).to.equal(ethers.parseEther("3"));
    expect(await vault.dayTotal(1)).to.equal(ethers.parseEther("5"));

    await expect(vault.closeDay(1)).to.be.revertedWithCustomError(vault, "WindowNotOpen"); // day 1's window hasn't closed yet
  });

  it("a bid day closes correctly: platform gets exactly 10%, the rest buy-and-burns against the curve, bidders claim pro-rata", async () => {
    const { curve, pool: poolAddr, vault, token } = await launchWithAuction("BidClose", 1);
    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });
    await vault.connect(bob).bid(1, { value: ethers.parseEther("3") });
    const total = ethers.parseEther("4");

    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const tickBefore = (await pool.slot0())[1];
    const platformBefore = await ethers.provider.getBalance(platform.address);

    await ethers.provider.send("evm_increaseTime", [DAY + 1]);
    await ethers.provider.send("evm_mine", []);
    const rc = await (await vault.closeDay(1)).wait();
    expect(await vault.closed(1)).to.equal(true);

    const expectedPlatform = (total * 1000n) / 10000n; // PLATFORM_BPS = 10%
    expect((await ethers.provider.getBalance(platform.address)) - platformBefore).to.equal(expectedPlatform);

    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "DayClosed");
    expect(ev.args.totalBid).to.equal(total);
    expect(ev.args.toPlatform).to.equal(expectedPlatform);
    expect(ev.args.toCurve).to.equal(total - expectedPlatform);
    expect(ev.args.tokensBurned).to.be.gt(0n);
    expect(ev.args.tokensToStaking).to.equal(0n);

    // the burn-buy genuinely moved the curve's price (real swap, not bookkeeping)
    const tickAfter = (await pool.slot0())[1];
    expect(tickAfter).to.not.equal(tickBefore);

    const TOK = await ethers.getContractAt("LaunchToken", token);
    const deadBefore = await TOK.balanceOf(DEAD);
    expect(deadBefore).to.equal(ev.args.tokensBurned); // (nothing else burns on this token in this test)

    // pro-rata claims: alice bid 1/4 of the day, bob 3/4
    const tranche = await vault.dayTranche();
    const aliceBefore = await TOK.balanceOf(alice.address);
    await (await vault.connect(alice).claim(1)).wait();
    const aliceGot = (await TOK.balanceOf(alice.address)) - aliceBefore;
    expect(aliceGot).to.equal(tranche / 4n);

    const bobBefore = await TOK.balanceOf(bob.address);
    await (await vault.connect(bob).claim(1)).wait();
    const bobGot = (await TOK.balanceOf(bob.address)) - bobBefore;
    expect(bobGot).to.equal((tranche * 3n) / 4n);

    expect(aliceGot + bobGot).to.equal(tranche); // exact conservation, no dust lost

    await expect(vault.connect(alice).claim(1)).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
    await expect(vault.connect(dev).claim(1)).to.be.revertedWithCustomError(vault, "NothingBid");
    await expect(vault.closeDay(1)).to.be.revertedWithCustomError(vault, "AlreadyClosed");
  });

  it("a ZERO-bid day funds the vault's own dedicated RobinStaking pool instead of burning nothing", async () => {
    const { vault, token } = await launchWithAuction("ZeroBid", 1);
    const tranche = await vault.dayTranche();
    // deployed LAZILY (see DailyAuctionVault.sol's gas-budget note) — nothing exists until the first
    // zero-bid closeDay() call below, which is exactly what this test is confirming.
    expect(await vault.stakingPool()).to.equal(ethers.ZeroAddress);

    await ethers.provider.send("evm_increaseTime", [DAY + 1]);
    await ethers.provider.send("evm_mine", []);
    const rc = await (await vault.closeDay(1)).wait();
    const stakingAddr = await vault.stakingPool();
    expect(stakingAddr).to.not.equal(ethers.ZeroAddress);
    const staking = await ethers.getContractAt("RobinStaking", stakingAddr);
    expect(await staking.owner()).to.equal(await vault.getAddress());
    expect((await staking.rewardInfo(token))[0]).to.equal(true); // the coin itself is a LISTED reward asset
    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "DayClosed");
    expect(ev.args.totalBid).to.equal(0n);
    expect(ev.args.tokensToStaking).to.equal(tranche);
    expect(ev.args.tokensBurned).to.equal(0n);

    const TOK = await ethers.getContractAt("LaunchToken", token);
    expect(await TOK.balanceOf(stakingAddr)).to.equal(tranche); // the pool actually received the tokens

    // and it's a REAL stream: someone who stakes the coin now earns MORE of the coin over time
    await TOK.connect(dev).transfer(alice.address, ethers.parseEther("1000"));
    await TOK.connect(alice).approve(stakingAddr, ethers.MaxUint256);
    await staking.connect(alice).stake(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [15 * 24 * 3600]); // halfway through the 30-day stream
    await ethers.provider.send("evm_mine", []);
    const earned = await staking.earned(alice.address, token);
    expect(earned).to.be.gt(0n);
    expect(earned).to.be.lt(tranche); // streaming, not an instant lump
  });

  it("bidders can claim any time after close, even much later — pull-based, no forced deadline", async () => {
    const { vault } = await launchWithAuction("LateClaim", 1);
    await vault.connect(alice).bid(1, { value: ethers.parseEther("1") });
    await ethers.provider.send("evm_increaseTime", [DAY + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.closeDay(1)).wait();
    await ethers.provider.send("evm_increaseTime", [90 * DAY]); // long after everything else has settled
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(alice).claim(1)).to.not.be.reverted;
  });
});
