const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 1 — LockVault: the seed-LP lock is STRUCTURAL. This suite proves the surface has no
// liquidity-exit selector (invariant #2), the NFT is only acceptable from the canonical PositionManager
// (that acceptance IS the lock), registration is factory-only / one-shot, and the LP-fee routing
// (locked model: ALL LP fees → platform, with an optional immutable ETH-slice → staking) books its config
// correctly. The actual collectFees flow needs the real PositionManager → covered in test/fork + sim.

const ZERO = ethers.ZeroAddress;

describe("LockVault — collect-only, locked forever, all LP fees → platform (+ optional ETH slice)", () => {
  let factory, pmSigner, other, staking, reg, vault, c1;

  beforeEach(async () => {
    [factory, pmSigner, other, staking, c1] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(other.address, factory.address);
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
    expect(names).to.include("collectFees"); // the ONLY outward path
  });

  it("accepts the NFT only from the PositionManager", async () => {
    expect(await vault.connect(pmSigner).onERC721Received.staticCall(ZERO, ZERO, 1, "0x")).to.equal("0x150b7a02");
    await expect(vault.connect(other).onERC721Received(ZERO, ZERO, 1, "0x")).to.be.revertedWithCustomError(
      vault, "NotPositionManager"
    );
  });

  it("registerLaunch is factory-only and one-shot, and stores the immutable ETH-slice", async () => {
    await expect(vault.connect(other).registerLaunch(1, ZERO, c1.address, staking.address, 0))
      .to.be.revertedWithCustomError(vault, "NotFactory");
    await vault.connect(factory).registerLaunch(1, ZERO, c1.address, staking.address, 1500);
    const lk = await vault.locks(1);
    expect(lk.stakingRecipient).to.equal(staking.address);
    expect(lk.stakingEthShareBps).to.equal(1500n);
    await expect(vault.connect(factory).registerLaunch(1, ZERO, c1.address, staking.address, 0))
      .to.be.revertedWithCustomError(vault, "AlreadyRegistered");
  });

  it("rejects an ETH-slice above 100%", async () => {
    await expect(vault.connect(factory).registerLaunch(9, ZERO, c1.address, staking.address, 10001))
      .to.be.revertedWithCustomError(vault, "BadShare");
  });

  it("setStakingRecipient is platform-only and one-shot", async () => {
    // platform wallet is `other` (the registry's initial wallet)
    await vault.connect(factory).registerLaunch(2, ZERO, c1.address, ZERO, 500); // recipient unset at launch
    await expect(vault.connect(factory).setStakingRecipient(2, staking.address))
      .to.be.revertedWithCustomError(vault, "NotPlatform");
    await vault.connect(other).setStakingRecipient(2, staking.address);
    expect((await vault.locks(2)).stakingRecipient).to.equal(staking.address);
    await expect(vault.connect(other).setStakingRecipient(2, factory.address))
      .to.be.revertedWithCustomError(vault, "StakingRecipientAlreadySet");
  });

  it("claims revert with NothingToClaim before any fees are collected", async () => {
    await vault.connect(factory).registerLaunch(1, ZERO, c1.address, staking.address, 0);
    await expect(vault.claimPlatform(1, 0)).to.be.revertedWithCustomError(vault, "NothingToClaim");
    await expect(vault.claimPlatform(1, 1)).to.be.revertedWithCustomError(vault, "NothingToClaim"); // token leg → platform now
    await expect(vault.claimStaking(1, 0)).to.be.revertedWithCustomError(vault, "NothingToClaim");
  });
});
