// Per-function sim: RewardVault.claim() — the Merkle claim path (happy path + double-claim + bad-proof + the
// per-(coin,epoch,side) conservation cap fuse). Unit test with a MockFloorRouter driving accrue.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24 * 3600;
const EPOCH = 7 * DAY, FINALITY = 1 * DAY, CHALLENGE = 2 * DAY, CLAIM = 30 * DAY;
const abi = ethers.AbiCoder.defaultAbiCoder();

// OZ StandardMerkleTree leaf: double-keccak of abi.encode(epoch, coin, side, user, amount)
const leafOf = (epoch, coin, side, user, amount) =>
  ethers.keccak256(ethers.keccak256(abi.encode(["uint256", "address", "uint8", "address", "uint256"], [epoch, coin, side, user, amount])));
const hashPair = (a, b) => (BigInt(a) <= BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));

describe("RewardVault.claim — Merkle claim, double-claim guard, cap fuse", function () {
  async function setup() {
    const [dep, poster, guardian, owner, u1, u2] = await ethers.getSigners();
    const router = await (await ethers.getContractFactory("MockFloorRouter")).deploy();
    const vault = await (await ethers.getContractFactory("RewardVault")).deploy(
      await router.getAddress(), poster.address, guardian.address, EPOCH, FINALITY, CHALLENGE, CLAIM, owner.address);
    await (await router.setVault(await vault.getAddress())).wait();
    return { poster, owner, u1, u2, router, vault };
  }
  const coin = "0x000000000000000000000000000000000000c01d";
  const TRADERS = 0;

  it("two users claim their exact slices; double-claim + bad amount revert; cap holds", async () => {
    const { poster, u1, u2, router, vault } = await setup();
    const epoch = Number(await vault.currentEpoch());
    // fund the trader pot with exactly 0.5 ETH (0.3 for u1 + 0.2 for u2)
    await (await router.accrue(coin, TRADERS, { value: ethers.parseEther("0.5") })).wait();

    const a1 = ethers.parseEther("0.3"), a2 = ethers.parseEther("0.2");
    const l1 = leafOf(epoch, coin, TRADERS, u1.address, a1);
    const l2 = leafOf(epoch, coin, TRADERS, u2.address, a2);
    const root = hashPair(l1, l2); // 2-leaf tree; proof for one leaf is the other

    // post + wait out the challenge window
    await ethers.provider.send("evm_setNextBlockTimestamp", [(epoch + 1) * EPOCH + FINALITY + 5]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.connect(poster).postRoot(epoch, root, ethers.ZeroHash, "ipfs://x")).wait();
    await ethers.provider.send("evm_increaseTime", [CHALLENGE + 5]);
    await ethers.provider.send("evm_mine", []);

    // u1 claims 0.3
    const b1 = await ethers.provider.getBalance(u1.address);
    const rc1 = await (await vault.connect(u1).claim(epoch, coin, TRADERS, a1, [l2])).wait();
    const paid1 = (await ethers.provider.getBalance(u1.address)) - b1 + rc1.gasUsed * rc1.gasPrice;
    expect(paid1).to.equal(a1);

    // double-claim reverts
    await expect(vault.connect(u1).claim(epoch, coin, TRADERS, a1, [l2])).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
    // wrong amount => not in tree => BadProof
    await expect(vault.connect(u1).claim(epoch, coin, TRADERS, a2, [l2])).to.be.revertedWithCustomError(vault, "BadProof");

    // u2 claims 0.2 -> pot now fully distributed
    await (await vault.connect(u2).claim(epoch, coin, TRADERS, a2, [l1])).wait();
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
  });

  it("a leaf claiming more than the pot holds reverts CapExceeded (the fuse)", async () => {
    const { poster, u1, router, vault } = await setup();
    const epoch = Number(await vault.currentEpoch());
    await (await router.accrue(coin, TRADERS, { value: ethers.parseEther("0.5") })).wait(); // pot = 0.5

    const over = ethers.parseEther("0.6"); // more than the pot
    const leaf = leafOf(epoch, coin, TRADERS, u1.address, over);
    const root = leaf; // single-leaf tree: root == leaf, proof == []

    await ethers.provider.send("evm_setNextBlockTimestamp", [(epoch + 1) * EPOCH + FINALITY + 5]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.connect(poster).postRoot(epoch, root, ethers.ZeroHash, "ipfs://x")).wait();
    await ethers.provider.send("evm_increaseTime", [CHALLENGE + 5]);
    await ethers.provider.send("evm_mine", []);

    // proof is valid (root==leaf) but the amount exceeds the pot -> the conservation cap rejects it
    await expect(vault.connect(u1).claim(epoch, coin, TRADERS, over, [])).to.be.revertedWithCustomError(vault, "CapExceeded");
  });
});
