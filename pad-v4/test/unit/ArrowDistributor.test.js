const { ethers } = require("hardhat");
const { expect } = require("chai");

// ArrowDistributor — no-withdraw merkle self-claim airdrop for an Arrow migration launch.
// Verifies: leaf/proof matches the contract's double-hash + OZ sorted-pair verify, each index claims once,
// funds always go to the leaf account (not the caller), no withdraw path, and full claims drain to zero.

const abi = ethers.AbiCoder.defaultAbiCoder();

// leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount)))) — matches ArrowDistributor.claim
function leafOf(index, account, amount) {
  const inner = ethers.keccak256(abi.encode(["uint256", "address", "uint256"], [index, account, amount]));
  return ethers.keccak256(ethers.concat([inner]));
}
// commutative sorted-pair hash — matches OZ MerkleProof._hashPair
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}
function buildLayers(leaves) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const top = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < top.length; i += 2) {
      next.push(i + 1 < top.length ? hashPair(top[i], top[i + 1]) : top[i]); // promote odd
    }
    layers.push(next);
  }
  return layers;
}
function getProof(layers, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const pair = idx ^ 1;
    if (pair < layers[l].length) proof.push(layers[l][pair]);
    idx >>= 1;
  }
  return proof;
}

describe("ArrowDistributor — no-withdraw merkle self-claim", () => {
  let owner, a, b, c, stranger, token, dist, entries, layers, root, total;

  beforeEach(async () => {
    [owner, a, b, c, stranger] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 27n);

    entries = [
      { index: 0, account: a.address, amount: 1000n },
      { index: 1, account: b.address, amount: 2500n },
      { index: 2, account: c.address, amount: 4500n },
    ];
    total = entries.reduce((s, e) => s + e.amount, 0n); // 8000
    const leaves = entries.map((e) => leafOf(e.index, e.account, e.amount));
    layers = buildLayers(leaves);
    root = layers[layers.length - 1][0];

    dist = await (await ethers.getContractFactory("ArrowDistributor")).deploy(await token.getAddress(), root);
    await token.connect(owner).transfer(await dist.getAddress(), total); // launcher funds the bought supply
  });

  it("rejects a zero token or empty root at construction", async () => {
    const F = await ethers.getContractFactory("ArrowDistributor");
    await expect(F.deploy(ethers.ZeroAddress, root)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(await token.getAddress(), ethers.ZeroHash)).to.be.revertedWithCustomError(F, "EmptyRoot");
  });

  it("lets each holder claim exactly their committed amount", async () => {
    for (const e of entries) {
      const proof = getProof(layers, e.index);
      await expect(dist.claim(e.index, e.account, e.amount, proof))
        .to.emit(dist, "Claimed").withArgs(e.index, e.account, e.amount);
      expect(await token.balanceOf(e.account)).to.equal(e.amount);
      expect(await dist.isClaimed(e.index)).to.equal(true);
    }
    // ends at ZERO — the whole bought supply was distributed
    expect(await token.balanceOf(await dist.getAddress())).to.equal(0n);
    expect(await dist.totalClaimed()).to.equal(total);
  });

  it("sends funds to the leaf account even when a stranger triggers the claim", async () => {
    const e = entries[1];
    const proof = getProof(layers, e.index);
    await dist.connect(stranger).claim(e.index, e.account, e.amount, proof);
    expect(await token.balanceOf(b.address)).to.equal(e.amount);
    expect(await token.balanceOf(stranger.address)).to.equal(0n); // caller gets nothing
  });

  it("rejects a double claim", async () => {
    const e = entries[0];
    const proof = getProof(layers, e.index);
    await dist.claim(e.index, e.account, e.amount, proof);
    await expect(dist.claim(e.index, e.account, e.amount, proof)).to.be.revertedWithCustomError(dist, "AlreadyClaimed");
  });

  it("rejects a forged amount, wrong account, or bad proof", async () => {
    const e = entries[0];
    const proof = getProof(layers, e.index);
    await expect(dist.claim(e.index, e.account, e.amount + 1n, proof)).to.be.revertedWithCustomError(dist, "InvalidProof");
    await expect(dist.claim(e.index, stranger.address, e.amount, proof)).to.be.revertedWithCustomError(dist, "InvalidProof");
    await expect(dist.claim(e.index, e.account, e.amount, [])).to.be.revertedWithCustomError(dist, "InvalidProof");
    // a leaf that isn't in the tree at all
    await expect(dist.claim(9, stranger.address, 1n, proof)).to.be.revertedWithCustomError(dist, "InvalidProof");
  });

  it("exposes NO withdraw/rescue/owner path", () => {
    const banned = ["withdraw", "rescue", "sweep", "owner", "recover", "setroot", "settoken", "renounce"];
    const names = dist.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const b of banned) expect(names).to.not.include(b);
    expect(names).to.include("claim");
  });
});
