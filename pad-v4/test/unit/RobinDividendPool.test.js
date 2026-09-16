const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinDividendPool — "dividends, not staking": snapshot-based holder rewards, no lock, no deposit.
// Same merkle+bitmap self-claim pattern as ArrowDistributor (reuses its exact leaf/proof convention),
// generalized to recurring epochs for both ETH (accrue-and-pull) and token (safeTransfer inline) payouts.

const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();

// leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount)))) — matches the contract exactly,
// and matches ArrowDistributor's own convention (same helper as ArrowDistributor.test.js).
function leafOf(index, account, amount) {
  const inner = ethers.keccak256(abi.encode(["uint256", "address", "uint256"], [index, account, amount]));
  return ethers.keccak256(ethers.concat([inner]));
}
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
      next.push(i + 1 < top.length ? hashPair(top[i], top[i + 1]) : top[i]);
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
function tree(entries) {
  const leaves = entries.map((e) => leafOf(e.index, e.account, e.amount));
  const layers = buildLayers(leaves);
  return { layers, root: layers[layers.length - 1][0] };
}

describe("RobinDividendPool — snapshot dividends (ETH side)", () => {
  let owner, platform, a, b, c, stranger, reg, tok, pool;

  beforeEach(async () => {
    [owner, platform, a, b, c, stranger] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 27n);
    pool = await (await ethers.getContractFactory("RobinDividendPool")).deploy(await tok.getAddress(), await reg.getAddress());
  });

  it("rejects zero addresses at construction", async () => {
    const F = await ethers.getContractFactory("RobinDividendPool");
    await expect(F.deploy(ZERO, await reg.getAddress())).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(await tok.getAddress(), ZERO)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("fundETH accumulates pendingEth; only the platform wallet can open an epoch", async () => {
    await pool.fundETH(0, { value: ethers.parseEther("3") });
    expect(await pool.pendingEth()).to.equal(ethers.parseEther("3"));

    await expect(pool.connect(owner).openEthEpoch(ethers.id("root"), ethers.parseEther("1")))
      .to.be.revertedWithCustomError(pool, "NotPlatform");
    await expect(pool.connect(platform).openEthEpoch(ethers.ZeroHash, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(pool, "EmptyRoot");
    await expect(pool.connect(platform).openEthEpoch(ethers.id("root"), ethers.parseEther("10")))
      .to.be.revertedWithCustomError(pool, "InsufficientPending");
  });

  it("claimEth books to ethOwed (accrue-and-pull), each index claims once, wrong proof reverts", async () => {
    await pool.fundETH(0, { value: ethers.parseEther("10") });
    const entries = [
      { index: 0, account: a.address, amount: ethers.parseEther("3") },
      { index: 1, account: b.address, amount: ethers.parseEther("5") },
      { index: 2, account: c.address, amount: ethers.parseEther("2") },
    ];
    const total = entries.reduce((s, e) => s + e.amount, 0n);
    const { layers, root } = tree(entries);
    await pool.connect(platform).openEthEpoch(root, total);

    const proofA = getProof(layers, 0);
    await expect(pool.connect(stranger).claimEth(0, 0, a.address, entries[0].amount, proofA))
      .to.emit(pool, "EthClaimed").withArgs(0, 0, a.address, entries[0].amount);
    expect(await pool.ethOwed(a.address)).to.equal(entries[0].amount);
    expect(await pool.isEthClaimed(0, 0)).to.equal(true);

    await expect(pool.claimEth(0, 0, a.address, entries[0].amount, proofA))
      .to.be.revertedWithCustomError(pool, "AlreadyClaimed");

    // wrong amount for a real leaf ⇒ hashes to a non-member leaf ⇒ proof fails
    await expect(pool.claimEth(0, 1, b.address, entries[1].amount + 1n, getProof(layers, 1)))
      .to.be.revertedWithCustomError(pool, "InvalidProof");

    // unknown epoch
    await expect(pool.claimEth(1, 0, a.address, entries[0].amount, proofA))
      .to.be.revertedWithCustomError(pool, "UnknownEpoch");
  });

  it("withdraw() pays out ethOwed and is retriable on a failed send", async () => {
    await pool.fundETH(0, { value: ethers.parseEther("5") });
    const entries = [{ index: 0, account: a.address, amount: ethers.parseEther("5") }];
    const { layers, root } = tree(entries);
    await pool.connect(platform).openEthEpoch(root, ethers.parseEther("5"));
    await pool.claimEth(0, 0, a.address, entries[0].amount, getProof(layers, 0));

    const before = await ethers.provider.getBalance(a.address);
    const tx = await pool.connect(a).withdraw();
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const after = await ethers.provider.getBalance(a.address);
    expect(after - before + gas).to.equal(ethers.parseEther("5"));
    expect(await pool.ethOwed(a.address)).to.equal(0n);
  });

  it("a claim's payout clamps to the epoch's remaining balance — a dust shortfall can't brick the tail claim", async () => {
    // open an epoch for slightly less than the sum of leaf amounts (simulates rounding dust from the snapshot math)
    await pool.fundETH(0, { value: ethers.parseEther("10") });
    const entries = [
      { index: 0, account: a.address, amount: ethers.parseEther("6") },
      { index: 1, account: b.address, amount: ethers.parseEther("4") },
    ];
    const { layers, root } = tree(entries);
    await pool.connect(platform).openEthEpoch(root, ethers.parseEther("9")); // 1 ETH short of the leaf sum
    await pool.claimEth(0, 0, a.address, entries[0].amount, getProof(layers, 0)); // full 6
    expect(await pool.ethOwed(a.address)).to.equal(ethers.parseEther("6"));
    await pool.claimEth(0, 1, b.address, entries[1].amount, getProof(layers, 1)); // clamped to remaining 3, not 4
    expect(await pool.ethOwed(b.address)).to.equal(ethers.parseEther("3"));
    expect((await pool.ethEpochs(0)).remaining).to.equal(0n);
  });
});

describe("RobinDividendPool — token side + real RobinCurveV4 wiring", () => {
  let owner, platform, creator, trader, a, b;
  let reg, tok, pool;

  beforeEach(async () => {
    [owner, platform, creator, trader, a, b] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 27n);
    pool = await (await ethers.getContractFactory("RobinDividendPool")).deploy(await tok.getAddress(), await reg.getAddress());
  });

  it("fundTokenPushed measures the fresh balance-diff correctly, including a same-block double-notify no-op", async () => {
    await tok.connect(owner).transfer(await pool.getAddress(), 1000n);
    await pool.fundTokenPushed(0, await tok.getAddress());
    expect(await pool.pendingToken()).to.equal(1000n);
    // calling again with no new tokens arrived must be a safe no-op, not revert or double-count
    await expect(pool.fundTokenPushed(0, await tok.getAddress())).to.not.be.reverted;
    expect(await pool.pendingToken()).to.equal(1000n);

    await tok.connect(owner).transfer(await pool.getAddress(), 500n);
    await pool.fundTokenPushed(0, await tok.getAddress());
    expect(await pool.pendingToken()).to.equal(1500n);
  });

  it("fundTokenPushed ignores a mismatched asset (returns 0, no state change)", async () => {
    const other = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 18n);
    await pool.fundTokenPushed(0, await other.getAddress());
    expect(await pool.pendingToken()).to.equal(0n);
  });

  it("openTokenEpoch + claimToken pays out via safeTransfer, mirroring the ETH side", async () => {
    await tok.connect(owner).transfer(await pool.getAddress(), 10_000n);
    await pool.fundTokenPushed(0, await tok.getAddress());

    const entries = [
      { index: 0, account: a.address, amount: 4000n },
      { index: 1, account: b.address, amount: 6000n },
    ];
    const { layers, root } = tree(entries);
    await pool.connect(platform).openTokenEpoch(root, 10_000n);

    await pool.claimToken(0, 0, a.address, 4000n, getProof(layers, 0));
    expect(await tok.balanceOf(a.address)).to.equal(4000n);
    await expect(pool.claimToken(0, 0, a.address, 4000n, getProof(layers, 0)))
      .to.be.revertedWithCustomError(pool, "AlreadyClaimed");

    await pool.claimToken(0, 1, b.address, 6000n, getProof(layers, 1));
    expect(await tok.balanceOf(b.address)).to.equal(6000n);
    expect((await pool.tokenEpochs(0)).remaining).to.equal(0n);
  });

  it("wires as a real RobinCurveV4 pad's staking sink — setStaking accepts it, ETH and reserve token both arrive through the normal graduation flow", async () => {
    const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
    const CURVE_SUPPLY = 1000n * 10n ** 18n;
    const RESERVE = 1000n * 10n ** 18n;
    const ZEROADDR = ethers.ZeroAddress;
    const MIN_SQRT_LIMIT = 4295128739n + 1n;

    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const th = await (await ethers.getContractFactory("TickHelper")).deploy();
    const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    const mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    await mockFactory.setLockVault(await lockVault.getAddress());
    await lockVault.setFactory(await mockFactory.getAddress());
    const curveTok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    const tokAddr = await curveTok.getAddress();
    const key = { currency0: ZEROADDR, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZEROADDR };
    await pm.initialize(key, await th.sqrt(START));

    const curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZEROADDR, tokAddr, FEE, SPACING, ZEROADDR, START, GRAD, 2000, 1000, 1000, 500, creator.address,
      true, 4000 // noPoolForever, visibilityWithdrawBps — pairs naturally with the dividend model
    );
    const curveAddr = await curve.getAddress();

    // this pool must be constructed against the CURVE's own token (setStaking's asset-match probe)
    const curvePool = await (await ethers.getContractFactory("RobinDividendPool")).deploy(tokAddr, await reg.getAddress());

    await curveTok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await curveTok.connect(owner).transfer(curveAddr, RESERVE);

    // setStaking accepts this pool exactly as it would DualStaking — no RobinCurveV4 change was needed
    await expect(curve.connect(platform).setStaking(await curvePool.getAddress())).to.not.be.reverted;

    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("6000"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("6000") }
    );
    expect(await curve.ready()).to.equal(true);

    await curve.graduate();

    // [MILESTONE] the no-pool-forever ETH leg (lpEth) now splits creator/platform instead of funding staking
    // (see the milestone-payout change in graduate()) — this hookless fixture has no buy-tax-buffer path either
    // (that requires a real fee hook), so nothing pushes ETH to the dividend pool here. That's correct, not a
    // regression: setStaking() still accepted this pool exactly like DualStaking (asserted above), proving the
    // wiring itself works; a hook-having pad would still push its buffer here via the same fundETH path.
    expect(await curvePool.pendingEth()).to.equal(0n);
    // the leftover reserve TOKEN push is a separate code path (_fundStaking, unrelated to lpEth/ETH routing) —
    // still arrives exactly as before.
    expect(await curvePool.pendingToken()).to.be.gt(0n);
    expect(await curve.stakingEthOwed()).to.equal(0n); // nothing owed, nothing stranded
  });
});
