const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 1 — LockVault: the seed-LP lock is STRUCTURAL. This suite proves the surface has no
// liquidity-exit selector (invariant #2), the NFT is only acceptable from the canonical PositionManager
// (that acceptance IS the lock), registration is factory-only / one-shot, and the LP-fee routing
// (v2 model: quote/buy → platform, token/sell → staking) books correctly. The actual collectFees flow
// needs the real PositionManager → covered in test/fork.

const ZERO = ethers.ZeroAddress;

describe("LockVault — collect-only, locked forever, quote→platform / token→staking", () => {
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

  it("registerLaunch is factory-only and one-shot", async () => {
    await expect(vault.connect(other).registerLaunch(1, ZERO, c1.address, staking.address))
      .to.be.revertedWithCustomError(vault, "NotFactory");
    await vault.connect(factory).registerLaunch(1, ZERO, c1.address, staking.address);
    expect((await vault.locks(1)).stakingRecipient).to.equal(staking.address);
    await expect(vault.connect(factory).registerLaunch(1, ZERO, c1.address, staking.address))
      .to.be.revertedWithCustomError(vault, "AlreadyRegistered");
  });

  it("setStakingRecipient is platform-only and one-shot", async () => {
    // platform wallet is `other` (the registry's initial wallet)
    await vault.connect(factory).registerLaunch(2, ZERO, c1.address, ZERO); // unset at launch
    await expect(vault.connect(factory).setStakingRecipient(2, staking.address))
      .to.be.revertedWithCustomError(vault, "NotPlatform");
    await vault.connect(other).setStakingRecipient(2, staking.address);
    expect((await vault.locks(2)).stakingRecipient).to.equal(staking.address);
    await expect(vault.connect(other).setStakingRecipient(2, factory.address))
      .to.be.revertedWithCustomError(vault, "StakingRecipientAlreadySet");
  });

  it("claims revert with NothingToClaim before any fees are collected", async () => {
    await vault.connect(factory).registerLaunch(1, ZERO, c1.address, staking.address);
    await expect(vault.claimPlatform(1, 0)).to.be.revertedWithCustomError(vault, "NothingToClaim"); // quote/buy leg
    await expect(vault.claimStaking(1, 1)).to.be.revertedWithCustomError(vault, "NothingToClaim"); // token/sell leg
  });

  it("[M-11] claimStaking PARKS while the recipient is unwired — never silently pays the platform", async () => {
    // shipped-default on the curve path: graduate() registers with stakingRecipient == 0 until the platform wires it.
    await vault.connect(factory).registerLaunch(3, ZERO, c1.address, ZERO);
    // any claim of the locked LP's token (sell) fee reverts NoStakingRecipient — it does NOT route to platformFeeWallet.
    await expect(vault.claimStaking(3, 1)).to.be.revertedWithCustomError(vault, "NoStakingRecipient");
    // once the platform wires the real recipient, the same claim reverts NothingToClaim (nothing owed yet) — i.e. it
    // now targets the recipient and the accrual survives the unwired window (collectFees credits stakingOwed either way).
    await vault.connect(other).setStakingRecipient(3, staking.address);
    await expect(vault.claimStaking(3, 1)).to.be.revertedWithCustomError(vault, "NothingToClaim");
  });
});
