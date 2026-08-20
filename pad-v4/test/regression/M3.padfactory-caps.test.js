const { ethers } = require("hardhat");
const { expect } = require("chai");
const { brandedTokenSalt } = require("../helpers/brand");

// [M-3 / L-27] PadFactory is live tooling (deploy.js / launch.js) and used to let a launcher stamp their OWN
// buy/sell taxes up to the hook's 3%/side and carve up to 100% of the sell tax to a launcher-chosen address.
// It is now GOVERNED: launch() caps buy/sell tax at 2%/side, the floor share at 50%, and the static LP fee at 1%
// — the same policy the curve path enforces. These reject-branch tests pin the caps (they revert before any deploy).

const ZERO = ethers.ZeroAddress;

describe("[M-3 / L-27] PadFactory governed tax caps", () => {
  let owner, platform, creator, factory, depAddr, factoryAddr;

  const baseCfg = () => ({
    name: "Robin P", symbol: "P", decimals: 18,
    supply: 10n ** 24n, lpTokenAmount: 5n * 10n ** 23n,
    sqrtPriceX96: 79228162514264337593543950336n, tickSpacing: 60, fee: 3000,
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000,
    creator: creator.address, floorRecipient: ZERO, stakingRecipient: ZERO,
  });

  beforeEach(async () => {
    [owner, platform, creator] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    factory = await (await ethers.getContractFactory("PadFactory")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(),
      await dep.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    depAddr = await dep.getAddress();
    factoryAddr = await factory.getAddress();
  });

  // The cap checks revert at the top of launch(), before any deployment — but [brand] PadBrand.requireBrand
  // rejects any token address not ending in `faf0`, so a dummy tokenSalt would give these tests a SECOND way
  // to revert and a cap regression could pass as BadTokenSuffix. Mine the branded salt from the exact cfg
  // that is handed to launch() (so the two can never drift), keeping the old `id("t")` seed as the per-pad
  // base. The hook salt stays a dummy: no test here is meant to get as far as the hook.
  const launch = async (over) => {
    const cfg = { ...baseCfg(), ...over };
    const tokenSalt = await brandedTokenSalt(depAddr, factoryAddr, cfg, ethers.id("t"));
    return factory.launch(cfg, tokenSalt, ethers.id("h"));
  };

  it("rejects buyTaxBps > 2%", async () => {
    await expect(launch({ buyTaxBps: 201 })).to.be.revertedWithCustomError(factory, "BadConfig");
  });
  it("rejects sellTaxBps > 2%", async () => {
    await expect(launch({ sellTaxBps: 201 })).to.be.revertedWithCustomError(factory, "BadConfig");
  });
  it("rejects sellFloorShareBps > 50%", async () => {
    await expect(launch({ sellFloorShareBps: 5001 })).to.be.revertedWithCustomError(factory, "BadConfig");
  });
  it("rejects a static fee > 1%", async () => {
    await expect(launch({ fee: 10001 })).to.be.revertedWithCustomError(factory, "BadConfig");
  });
  it("a config AT the caps passes the governance gate (2% / 50% / 1%)", async () => {
    // at-cap params clear the BadConfig gate; the launch then proceeds past it (and reverts LATER for an unrelated
    // reason — the dummy, unmined HOOK salt / no seed value — never BadConfig, and never the brand check either
    // since the token salt is mined), proving the caps don't reject a valid governed config.
    await expect(launch({ buyTaxBps: 200, sellTaxBps: 200, sellFloorShareBps: 5000, fee: 10000 }))
      .to.not.be.revertedWithCustomError(factory, "BadConfig");
  });
});
