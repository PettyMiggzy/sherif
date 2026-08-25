const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { bindSalt, brandedTokenSalt } = require("../helpers/brand");

// [brand] Every Robin pad token address must end in `1ab5`. This is enforced IN THE CONTRACT
// (PadBrand.requireBrand, called by all three factories' launch), never merely by the launch tooling — an
// off-chain convention would hold only as long as every client remembered to mine, which is exactly the
// "config-enforced, not contract-enforced" weakness round-3 F1 was restructured to eliminate.
//
// This pins the rule end-to-end: an unmined salt REVERTS (so no client can silently launch an unbranded
// coin), a mined salt SUCCEEDS and the live token really carries the suffix, and the failure lands before
// any pool/curve state is written so a rejected launch cannot half-create a pad.

const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const START = 6000, GRAD = 3000, TS = 60, FEE = 10000, MINGRAD = 1800;

describe("[brand] pad token addresses are contract-forced to end in 1ab5", () => {
  let deployer, platform, creator, S;

  before(async () => {
    [deployer, platform, creator] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
    const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 0, buyBufferShareBps: 2000, referralShareBps: 0,
      platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
      lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
      // [FDV] band deliberately OPEN in this fixture: these tests exercise curve mechanics over many toy
      // supplies, not the product's valuation policy. The band itself is proven in FDV.creator-supply.test.js.
      minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n, // = HARD_MAX_FDV_WEI
    });
    const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());
    S = { pm, dep, reg, factory };
  });

  const cfgFor = (tag) => ({
    name: "Robin " + tag, symbol: tag, decimals: 18,
    supply: 2000n * 10n ** 18n, curveSupply: 1000n * 10n ** 18n, reserveSupply: 1000n * 10n ** 18n,
    tickSpacing: TS, startTickMag: 0, creator: creator.address,
  });

  // mine the hook salt against whatever token address `tokenSalt` produces (the hook init-code embeds it)
  async function hookSaltFor(cfg, tokenSalt) {
    const TokenF = await ethers.getContractFactory("PadToken");
    const init = ethers.concat([
      TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await S.factory.getAddress()]),
    ]);
    const predicted = ethers.getCreate2Address(await S.dep.getAddress(), bindSalt(cfg, tokenSalt), ethers.keccak256(init));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt } = mineHookSalt(
      await S.dep.getAddress(),
      hookInitCode(HookF.bytecode, await S.pm.getAddress(), await S.factory.getAddress(), await S.reg.getAddress(), predicted)
    );
    return { hookSalt: salt, predicted };
  }

  it("REJECTS a launch whose token address is not branded — an unmined salt cannot launch a coin", async () => {
    const cfg = cfgFor("UNBRAND");
    // a plain arbitrary salt, exactly what every launch used before the brand rule
    const tokenSalt = ethers.id("arbitrary-unmined-salt");
    const { hookSalt, predicted } = await hookSaltFor(cfg, tokenSalt);
    expect(predicted.toLowerCase().endsWith("1ab5")).to.equal(false); // precondition: genuinely unbranded

    await expect(S.factory.launch(cfg, tokenSalt, hookSalt, ethers.id("curve-UNBRAND")))
      .to.be.revertedWithCustomError(S.factory, "BadTokenSuffix")
      .withArgs(predicted);
    // and nothing was half-created: the pad never registered
    expect(await S.factory.poolOf(predicted)).to.equal(ethers.ZeroHash);
  });

  it("ACCEPTS a mined salt, and the live token really ends in 1ab5", async () => {
    const cfg = cfgFor("BRANDED");
    const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id("tok-BRANDED"));
    const { hookSalt } = await hookSaltFor(cfg, tokenSalt);

    const [token] = await S.factory.launch.staticCall(cfg, tokenSalt, hookSalt, ethers.id("curve-BRANDED"));
    await (await S.factory.launch(cfg, tokenSalt, hookSalt, ethers.id("curve-BRANDED"))).wait();

    expect(token.toLowerCase().endsWith("1ab5")).to.equal(true);
    expect(BigInt(token) & 0xffffn).to.equal(0x1ab5n);
    // it is a real, fully-launched pad — not just an address that passed a check
    expect(await (await ethers.getContractAt("PadToken", token)).symbol()).to.equal("BRANDED");
    expect(await S.factory.poolOf(token)).to.not.equal(ethers.ZeroHash);
  });

  it("the rule has NO bypass: there is no setter, flag, or owner path to disable it", async () => {
    const src = require("fs").readFileSync(__dirname + "/../../contracts/core/PadBrand.sol", "utf8");
    expect(src).to.not.match(/function set|onlyOwner|bool .*enabled|immutable/); // no switch of any kind
    // the constant is the literal suffix, so a silent retune is visible in the diff
    expect(src).to.match(/SUFFIX\s*=\s*0x1ab5/);
    expect(src).to.match(/SUFFIX_MASK\s*=\s*0xffff/);
  });
});
