// Round-1 audit finding (RewardVault.sol:221, stuck-funds): a NEVER-finalized epoch's rewards were stuck forever
// (claim + sweep both require a valid, non-vetoed root). This proves the emergencySweep safety valve: after a long
// grace past the whole lifecycle it forwards the pot to the coin's OWN floor, works for both the no-root and the
// vetoed cases, and can't fire early or twice.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24 * 3600;
const EPOCH = 7 * DAY, FINALITY = 1 * DAY, CHALLENGE = 2 * DAY, CLAIM = 30 * DAY;
const GRACE = 180 * DAY;

describe("RewardVault.emergencySweep — never-finalized epoch can't strand rewards", function () {
  async function deploy() {
    const [dep, poster, guardian, owner] = await ethers.getSigners();
    const router = await (await ethers.getContractFactory("MockFloorRouter")).deploy();
    const vault = await (await ethers.getContractFactory("RewardVault")).deploy(
      await router.getAddress(), poster.address, guardian.address, EPOCH, FINALITY, CHALLENGE, CLAIM, owner.address);
    await (await router.setVault(await vault.getAddress())).wait();
    return { dep, poster, guardian, owner, router, vault };
  }
  const coin = "0x000000000000000000000000000000000000c01d";

  it("no-root epoch: stuck before grace, sweeps to floor after grace, not twice", async () => {
    const { router, vault } = await deploy();
    const epoch = Number(await vault.currentEpoch());
    await (await router.accrue(coin, 0, { value: ethers.parseEther("0.30") })).wait(); // trader leg
    await (await router.accrue(coin, 1, { value: ethers.parseEther("0.20") })).wait(); // holder leg

    // no root ever posted -> normal claim & sweep are impossible
    await expect(vault.sweep(epoch, coin)).to.be.revertedWithCustomError(vault, "NoRoot");

    // move just past epoch end but well before the emergency deadline -> still TooEarly
    await ethers.provider.send("evm_setNextBlockTimestamp", [(epoch + 1) * EPOCH + FINALITY + CHALLENGE + CLAIM + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.emergencySweep(epoch, coin)).to.be.revertedWithCustomError(vault, "TooEarly");

    // warp past the full deadline (lifecycle + 180d grace)
    const deadline = (epoch + 1) * EPOCH + FINALITY + CHALLENGE + CLAIM + GRACE;
    await ethers.provider.send("evm_setNextBlockTimestamp", [deadline + 1]);
    await ethers.provider.send("evm_mine", []);

    await (await vault.emergencySweep(epoch, coin)).wait();
    expect(await router.donatedTo(coin)).to.equal(ethers.parseEther("0.50")); // whole pot -> the coin's floor
    // cannot double-sweep
    await expect(vault.emergencySweep(epoch, coin)).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
  });

  it("vetoed-and-never-reposted epoch also rescues to floor after grace", async () => {
    const { poster, guardian, router, vault } = await deploy();
    const epoch = Number(await vault.currentEpoch());
    await (await router.accrue(coin, 0, { value: ethers.parseEther("0.10") })).wait();

    // poster posts a root, guardian vetoes it, poster never re-posts
    await ethers.provider.send("evm_setNextBlockTimestamp", [(epoch + 1) * EPOCH + FINALITY + 10]);
    await ethers.provider.send("evm_mine", []);
    const root = ethers.keccak256(ethers.toUtf8Bytes("root"));
    await (await vault.connect(poster).postRoot(epoch, root, ethers.ZeroHash, "ipfs://x")).wait();
    await (await vault.connect(guardian).veto(epoch)).wait();

    // claim & normal sweep now revert Vetoed
    await expect(vault.sweep(epoch, coin)).to.be.revertedWithCustomError(vault, "Vetoed");

    const deadline = (epoch + 1) * EPOCH + FINALITY + CHALLENGE + CLAIM + GRACE;
    await ethers.provider.send("evm_setNextBlockTimestamp", [deadline + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.emergencySweep(epoch, coin)).wait();
    expect(await router.donatedTo(coin)).to.equal(ethers.parseEther("0.10"));
  });

  const MAX_POST = 90 * DAY;

  it("postRoot is rejected after MAX_POST_DELAY, so no root can appear after the emergency window opens", async () => {
    const { poster, router, vault } = await deploy();
    const epoch = Number(await vault.currentEpoch());
    await (await router.accrue(coin, 0, { value: ethers.parseEther("0.10") })).wait();
    // jump past the post deadline (epoch end + finality + 90d)
    await ethers.provider.send("evm_setNextBlockTimestamp", [(epoch + 1) * EPOCH + FINALITY + MAX_POST + 1]);
    await ethers.provider.send("evm_mine", []);
    const root = ethers.keccak256(ethers.toUtf8Bytes("late"));
    await expect(vault.connect(poster).postRoot(epoch, root, ethers.ZeroHash, "ipfs://x")).to.be.revertedWithCustomError(vault, "TooLate");
  });

  it("emergencySweep refuses a FINALIZED epoch (valid root) — it must use the normal postedAt-anchored sweep", async () => {
    const { poster, router, vault } = await deploy();
    const epoch = Number(await vault.currentEpoch());
    await (await router.accrue(coin, 0, { value: ethers.parseEther("0.10") })).wait();
    // post a valid (non-vetoed) root well within the deadline
    await ethers.provider.send("evm_setNextBlockTimestamp", [(epoch + 1) * EPOCH + FINALITY + 100]);
    await ethers.provider.send("evm_mine", []);
    const root = ethers.keccak256(ethers.toUtf8Bytes("valid"));
    await (await vault.connect(poster).postRoot(epoch, root, ethers.ZeroHash, "ipfs://x")).wait();
    // even far past the emergency deadline, emergencySweep refuses because a valid root exists
    const deadline = (epoch + 1) * EPOCH + FINALITY + CHALLENGE + CLAIM + GRACE;
    await ethers.provider.send("evm_setNextBlockTimestamp", [deadline + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.emergencySweep(epoch, coin)).to.be.revertedWithCustomError(vault, "TooEarly");
    // the normal sweep still works for it (funds not stranded)
    await (await vault.sweep(epoch, coin)).wait();
    expect(await router.donatedTo(coin)).to.equal(ethers.parseEther("0.10"));
  });
});
