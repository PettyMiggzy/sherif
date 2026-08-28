const { expect } = require("chai");
const { ethers } = require("hardhat");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
// robin-mine is an ES module — the site, the bot and the SDK import it directly. Loading THAT file here,
// rather than a CommonJS transcription of it, is the point: this suite proves the miner clients actually run
// agrees with the chain.
let RobinMine;

// [BRAND] Every Robin coin address ends in `1ab5`, and that is a RULE — not a creator preference and not a
// tooling convention. `PadBrand.requireBrand` enforces it inside `_launch`, so there is no entrypoint, flag or
// privileged path that opens a pad at an unbranded address.
//
// The rule only holds if THREE things agree: the contract's CREATE2 chain, the deployer's on-chain prediction,
// and the off-chain miner every client runs. This file pins all three against each other and against a real launch —
// checking the miner against the deployer alone would pass just as happily if both were wrong the same way.
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const NAME = "Robin Brand", SYMBOL = "BRAND";

describe("[BRAND] every coin address ends in 1ab5", () => {
  let dep, platform, dev, other, factory, factoryAddr, ltd, ltdC, ctx;

  const paramsFor = (devAddr) => ({
    name: NAME,
    symbol: SYMBOL,
    dev: devAddr,
    tax: { buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: devAddr },
  });

  before(async function () {
    this.timeout(180000);
    RobinMine = await import("../mine/robin-mine.mjs");
    [dep, platform, dev, other] = (await ethers.getSigners()).slice(-4);
    const at = async (name, ...args) =>
      (await ethers.getContractFactory(name)).connect(dep).deploy(...args).then((c) => c.getAddress());
    const weth = await at("MockWETH9");
    // the REAL v3 factory from @uniswap/v3-core bytecode — the repo mock cannot mint the concentrated
    // position CurvePool seeds, so with it no launch completes and the prediction could only be compared
    // against itself
    const v3 = await new ethers.ContractFactory(V3_FACTORY_ART.abi, V3_FACTORY_ART.bytecode, dep)
      .deploy().then((c) => c.getAddress());
    ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    const router = await at("PadRouter", weth, dep.address);
    factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd,
      ethers.ZeroAddress, START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    );
    factoryAddr = await factory.getAddress();
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(factoryAddr)).wait();
    // The prediction views live ON the LaunchTokenDeployer, not in a separate lens: that is the contract
    // embedding LaunchToken's creation code, so the hash it serves is by construction the code it deploys.
    ltdC = await ethers.getContractAt("LaunchTokenDeployer", ltd);

    ctx = {
      tokenDeployer: ltd,
      factory: factoryAddr,
      creator: dev.address,
      initCodeHash: await ltdC.tokenInitCodeHash(NAME, SYMBOL, SUPPLY, factoryAddr),
    };
  });

  it("the deployer's init-code hash is the one it actually deploys", async () => {
    // The view exists so a browser never has to carry LaunchToken's bytecode. That is only safe if the hash it
    // serves is the compiled artifact's — recompute it here from the artifact rather than trusting the view.
    const art = await ethers.getContractFactory("LaunchToken");
    const guard = { deadSecs: 0, phase1Secs: 0, antiSnipeSecs: 0, maxTxBps1: 0, maxWalletBps1: 0, maxTxBps2: 0, maxWalletBps2: 0, cooldownSecs: 0 };
    const initCode = ethers.concat([art.bytecode, art.interface.encodeDeploy([NAME, SYMBOL, SUPPLY, factoryAddr, guard])]);
    expect(ctx.initCodeHash).to.equal(ethers.keccak256(initCode));
  });

  it("the off-chain miner and the on-chain predict agree", async () => {
    for (const s of [ethers.id("a"), ethers.id("b"), ethers.id("c")]) {
      expect(RobinMine.predict(ethers, ctx, s)).to.equal(
        await ltdC.predict(factoryAddr, dev.address, s, NAME, SYMBOL, SUPPLY)
      );
    }
  });

  it("a mined salt launches, and the coin lands on the address that was mined", async function () {
    this.timeout(300000); // a full 16-bit suffix is ~65k tries of three keccaks
    const { salt, addr, tries } = RobinMine.mineSalt(ethers, ctx, ethers.id(`${SYMBOL}-${NAME}-${factoryAddr}`));
    console.log(`   mined ${addr} in ${tries} tries`);
    expect(addr.toLowerCase().endsWith("1ab5")).to.equal(true);

    const [token] = await factory.connect(dev).launchWithSalt.staticCall(paramsFor(dev.address), salt);
    expect(token).to.equal(addr); // the factory really lands where the miner said

    await (await factory.connect(dev).launchWithSalt(paramsFor(dev.address), salt)).wait();
    expect((await ethers.provider.getCode(addr)).length).to.be.greaterThan(2);
    expect(await (await ethers.getContractAt("LaunchToken", addr)).symbol()).to.equal(SYMBOL);
  });

  it("an UNMINED salt is rejected — the brand is not advisory", async () => {
    // ~65535/65536 of all salts land unbranded, so any fixed one is overwhelmingly likely to fail; assert the
    // prediction is unbranded first so this can never silently become a vacuous test.
    const salt = ethers.id("nobody-mined-this");
    expect(RobinMine.isBranded(RobinMine.predict(ethers, ctx, salt))).to.equal(false);
    await expect(factory.connect(dev).launchWithSalt(paramsFor(dev.address), salt))
      .to.be.revertedWithCustomError(factory, "BadTokenSuffix");
  });

  it("the salt-less entrypoints say SaltRequired instead of failing on the suffix", async () => {
    // `launch` and `launchWithSupply` derived a block-dependent salt nobody can mine against. Under the brand
    // rule they can only ever revert, so they revert with a name that says WHY rather than BadTokenSuffix,
    // which would send a caller off to debug their mining when they simply have not started.
    await expect(factory.connect(dev).launch(paramsFor(dev.address)))
      .to.be.revertedWithCustomError(factory, "SaltRequired");
    await expect(factory.connect(dev).launchWithSupply(paramsFor(dev.address), SUPPLY, 201600))
      .to.be.revertedWithCustomError(factory, "SaltRequired");
  });

  it("a mined salt is worthless to anyone but the wallet that mined it", async function () {
    this.timeout(300000);
    // The factory folds msg.sender into the salt, so publishing your coin's address before launching it is
    // safe: someone else replaying the salt lands somewhere unbranded and cannot even launch.
    const { salt, addr } = RobinMine.mineSalt(ethers, ctx, ethers.id("mine-then-steal"));
    const theirs = RobinMine.predict(ethers, { ...ctx, creator: other.address }, salt);
    expect(theirs).to.not.equal(addr);
    expect(RobinMine.isBranded(theirs)).to.equal(false);
    await expect(factory.connect(other).launchWithSalt(paramsFor(other.address), salt))
      .to.be.revertedWithCustomError(factory, "BadTokenSuffix");
  });
});
