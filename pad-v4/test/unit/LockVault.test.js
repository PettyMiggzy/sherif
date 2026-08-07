const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 1 — LockVault: the seed-LP lock is STRUCTURAL. This suite proves the surface has no
// liquidity-exit selector at all (invariant #2), the NFT is only acceptable from the canonical
// PositionManager (that acceptance IS the lock), and registration is factory-only / one-shot /
// fee-bounded. The actual collectFees flow needs the real PositionManager → covered in test/fork.

const ZERO = ethers.ZeroAddress;

describe("LockVault — collect-only, locked forever", () => {
  let factory, pmSigner, other, creator, reg, vault, c0, c1;

  beforeEach(async () => {
    [factory, pmSigner, other, creator, c0, c1] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(other.address, factory.address);
    // positionManager is just an address for these surface/guard tests; use pmSigner's address
    vault = await (await ethers.getContractFactory("LockVault")).deploy(pmSigner.address, await reg.getAddress());
    await vault.setFactory(factory.address); // bootstrap one-shot (deployer == this test signer)
  });

  it("setFactory is initializer-only and one-shot", async () => {
    const v2 = await (await ethers.getContractFactory("LockVault")).deploy(pmSigner.address, await reg.getAddress());
    await expect(v2.connect(other).setFactory(factory.address)).to.be.revertedWithCustomError(v2, "NotInitializer");
    await v2.setFactory(factory.address);
    await expect(v2.setFactory(other.address)).to.be.revertedWithCustomError(v2, "FactoryAlreadySet");
  });

  it("exposes NO liquidity-exit selector (structural lock)", () => {
    const banned = ["decreaseLiquidity", "burn", "transfer", "transferFrom", "approve", "setApprovalForAll", "modifyLiquidity"];
    const names = vault.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    for (const b of banned) expect(names, `must not expose ${b}`).to.not.include(b);
    // the ONLY outward path:
    expect(names).to.include("collectFees");
  });

  it("accepts the NFT only from the PositionManager", async () => {
    // from PM → ok (returns the magic selector)
    expect(
      await vault.connect(pmSigner).onERC721Received.staticCall(ZERO, ZERO, 1, "0x")
    ).to.equal("0x150b7a02");
    // from anyone else → revert
    await expect(vault.connect(other).onERC721Received(ZERO, ZERO, 1, "0x")).to.be.revertedWithCustomError(
      vault,
      "NotPositionManager"
    );
  });

  it("registerLaunch is factory-only, fee-bounded, one-shot", async () => {
    await expect(
      vault.connect(other).registerLaunch(1, creator.address, 500, ZERO, c1.address)
    ).to.be.revertedWithCustomError(vault, "NotFactory");

    await expect(
      vault.connect(factory).registerLaunch(1, creator.address, 50, ZERO, c1.address)
    ).to.be.revertedWithCustomError(vault, "InvalidCreatorFee"); // < 1%
    await expect(
      vault.connect(factory).registerLaunch(1, creator.address, 1500, ZERO, c1.address)
    ).to.be.revertedWithCustomError(vault, "InvalidCreatorFee"); // > 10%

    await vault.connect(factory).registerLaunch(1, creator.address, 500, ZERO, c1.address);
    await expect(
      vault.connect(factory).registerLaunch(1, creator.address, 500, ZERO, c1.address)
    ).to.be.revertedWithCustomError(vault, "AlreadyRegistered");
  });

  it("claims revert with NothingToClaim before any fees are collected", async () => {
    await vault.connect(factory).registerLaunch(1, creator.address, 500, ZERO, c1.address);
    await expect(vault.claimCreator(1, 0)).to.be.revertedWithCustomError(vault, "NothingToClaim");
    await expect(vault.claimPlatform(1, 1)).to.be.revertedWithCustomError(vault, "NothingToClaim");
  });
});
