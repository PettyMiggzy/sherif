const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");

// SIM — the trustless PresaleVault + PresaleVaultFactory end to end, on a REAL local Uniswap v4 stack.
// A creator opens a refundable ETH presale (target + deadline + per-wallet cap) via the factory. Anyone deposits;
// once the target is met, finalize() launches the curve AND does the pooled first buy ATOMICALLY (commit-reveal
// salts), and depositors pull tokens PRO-RATA (plus any unspent-ETH refund). If it fails or is never finalized,
// everyone refunds 100%. We reuse the exact deployStack + salt/predict/mine harness from curve.e2e.sim.test.js;
// the only difference is the mined salts flow through createPresale (committed) and finalize (revealed).

const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));

// geometry: START=6000 -> GRAD=3000 (ts=60). buyTax 1% + sellTax 1% + lpFee 1%. Same defaults as the e2e stack.
const START = 6000, GRAD = 3000, TS = 60, FEE = 10000, MINGRAD = 1800;

async function deployStack(deployer, platform) {
  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
  const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
  const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
  const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
  const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
  const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
  const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
  const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
  const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
    platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
    lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
  });
  const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
  );
  await lockVault.setFactory(await factory.getAddress());
  return { pm, stateView, dep, reg, permit2, posm, lockVault, factory };
}

describe("SIM — trustless PresaleVault + PresaleVaultFactory (launch + pooled buy, claim, refund)", () => {
  let signers, deployer, platform, creator, S;
  let presaleFactory, impl;
  let factoryAddr, depAddr, pmAddr, regAddr;
  let tagN = 0; // unique tag per presale => unique CREATE2 salts (no cross-test collisions)

  before(async () => {
    signers = await ethers.getSigners();
    deployer = signers[0];
    platform = signers[1];
    creator = signers[2];
    S = await deployStack(deployer, platform);

    // implementation stays uninitialized (plain deploy); factory clones it per presale
    impl = await (await ethers.getContractFactory("PresaleVault")).deploy();
    presaleFactory = await (await ethers.getContractFactory("PresaleVaultFactory")).deploy(
      await S.factory.getAddress(), await impl.getAddress()
    );

    factoryAddr = await S.factory.getAddress();
    depAddr = await S.dep.getAddress();
    pmAddr = await S.pm.getAddress();
    regAddr = await S.reg.getAddress();
  });

  // ── harness: build a LaunchConfig + mine the commit-reveal salts (verbatim from the e2e launchPad logic) ──
  function makeCfg(tag, { supply, curveSupply, reserveSupply }) {
    return {
      name: "Robin " + tag, symbol: tag, decimals: 18,
      supply, curveSupply, reserveSupply, tickSpacing: TS, creator: creator.address,
    };
  }

  async function prepareSalts(tag, cfg) {
    const tokenSalt = ethers.id("tok-" + tag);
    const curveSalt = ethers.id("curve-" + tag);
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenInit = ethers.concat([
      TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, factoryAddr]),
    ]);
    const predictedToken = ethers.getCreate2Address(depAddr, tokenSalt, ethers.keccak256(tokenInit));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(depAddr, hookInitCode(HookF.bytecode, pmAddr, factoryAddr, regAddr, predictedToken));
    // saltCommitment == keccak256(abi.encode(tokenSalt, hookSalt, curveSalt)) — revealed only in finalize()
    const commitment = ethers.keccak256(abi.encode(["bytes32", "bytes32", "bytes32"], [tokenSalt, hookSalt, curveSalt]));
    return { tokenSalt, hookSalt, curveSalt, commitment, predictedToken };
  }

  // default deep-curve config: a few-ETH pooled buy stays comfortably under graduation (measured tokens > 0)
  function deepCfg(tag) {
    const curveSupply = 100000n * 10n ** 18n, reserveSupply = 100000n * 10n ** 18n;
    return makeCfg(tag, { supply: curveSupply + reserveSupply, curveSupply, reserveSupply });
  }

  // open a presale: returns { vault, vaultAddr, cfg, salts }
  async function openPresale(terms, cfgOverride) {
    const tag = "PSL" + (tagN++);
    const cfg = cfgOverride || deepCfg(tag);
    const salts = await prepareSalts(tag, cfg);
    const now = await time.latest();
    const t = {
      target: E(3), deadline: BigInt(now) + 2n * 86400n, perWalletCap: E(2),
      minContribution: E("0.1"), finalizeGrace: 86400n, ...terms,
    };
    const vaultAddr = await presaleFactory.createPresale.staticCall(
      cfg, salts.commitment, t.target, t.deadline, t.perWalletCap, t.minContribution, t.finalizeGrace
    );
    await (await presaleFactory.createPresale(
      cfg, salts.commitment, t.target, t.deadline, t.perWalletCap, t.minContribution, t.finalizeGrace
    )).wait();
    const vault = await ethers.getContractAt("PresaleVault", vaultAddr);
    return { vault, vaultAddr, cfg, salts, terms: t };
  }

  // ETH delta helper accounting for gas: returns { net } where net = balanceAfter - balanceBefore + gasSpent
  async function ethDelta(addr, txPromise) {
    const before = await ethers.provider.getBalance(addr);
    const rc = await (await txPromise).wait();
    const after = await ethers.provider.getBalance(addr);
    return after - before + rc.gasUsed * rc.gasPrice;
  }

  // 1) createPresale registers + initializes the vault
  it("createPresale registers the vault and initializes it", async () => {
    const tag = "REG" + (tagN++);
    const cfg = deepCfg(tag);
    const salts = await prepareSalts(tag, cfg);
    const now = await time.latest();
    const target = E(3), deadline = BigInt(now) + 2n * 86400n;

    const before = await presaleFactory.presaleCount();
    const predicted = await presaleFactory.createPresale.staticCall(
      cfg, salts.commitment, target, deadline, E(2), E("0.1"), 86400n
    );
    await expect(presaleFactory.createPresale(cfg, salts.commitment, target, deadline, E(2), E("0.1"), 86400n))
      .to.emit(presaleFactory, "PresaleCreated").withArgs(predicted, creator.address, target, deadline);

    expect(await presaleFactory.isPresale(predicted)).to.equal(true);
    expect(await presaleFactory.presaleCount()).to.equal(before + 1n);
    expect(await presaleFactory.presales(before)).to.equal(predicted);

    const vault = await ethers.getContractAt("PresaleVault", predicted);
    expect(await vault.state()).to.equal(0); // Open
    // NB: `target` is a reserved property on an ethers v6 Contract (it holds the address), so call the
    // Solidity getter explicitly via getFunction rather than vault.target().
    expect(await vault.getFunction("target")()).to.equal(target);
    expect(await vault.deadline()).to.equal(deadline);
    expect(await vault.token()).to.equal(ZERO);
    expect(await vault.initialized()).to.equal(true);
  });

  // 2) initialize bounds -> BadParams
  it("initialize bounds: bad target / deadline / minContribution revert BadParams", async () => {
    const tag = "BND" + (tagN++);
    const cfg = deepCfg(tag);
    const salts = await prepareSalts(tag, cfg);
    const now = await time.latest();
    const okDeadline = BigInt(now) + 2n * 86400n;

    // target below MIN_TARGET (0.01 ether)
    await expect(
      presaleFactory.createPresale(cfg, salts.commitment, E("0.005"), okDeadline, E(2), E("0.001"), 86400n)
    ).to.be.revertedWithCustomError(impl, "BadParams");

    // deadline too soon (< now + MIN_DURATION 1h)
    await expect(
      presaleFactory.createPresale(cfg, salts.commitment, E(3), BigInt(now) + 1800n, E(2), E("0.1"), 86400n)
    ).to.be.revertedWithCustomError(impl, "BadParams");

    // minContribution > target
    await expect(
      presaleFactory.createPresale(cfg, salts.commitment, E(3), okDeadline, E(2), E(4), 86400n)
    ).to.be.revertedWithCustomError(impl, "BadParams");

    // finalizeGrace below GRACE_MIN (1h)
    await expect(
      presaleFactory.createPresale(cfg, salts.commitment, E(3), okDeadline, E(2), E("0.1"), 60n)
    ).to.be.revertedWithCustomError(impl, "BadParams");
  });

  // 3) deposit mechanics
  it("deposit: BelowMin, records contribution/totalRaised, and CapExceeded", async () => {
    // wide target (10 ETH) so `room` never trims the deposit before the per-wallet cap (2 ETH) binds
    const { vault } = await openPresale({ target: E(10), perWalletCap: E(2), minContribution: E("0.1") });
    const [a, b] = [signers[3], signers[4]];

    // below minContribution -> BelowMin
    await expect(vault.connect(a).deposit({ value: E("0.05") })).to.be.revertedWithCustomError(vault, "BelowMin");

    // a normal deposit records contribution + totalRaised, and bumps depositorCount
    await expect(vault.connect(a).deposit({ value: E(1) })).to.not.be.reverted;
    expect(await vault.contribution(a.address)).to.equal(E(1));
    expect(await vault.totalRaised()).to.equal(E(1));
    expect(await vault.depositorCount()).to.equal(1n);

    // 2.5 ETH exceeds the 2 ETH per-wallet cap (room is 9 ETH, so accept isn't trimmed) -> CapExceeded
    await expect(vault.connect(b).deposit({ value: E("2.5") })).to.be.revertedWithCustomError(vault, "CapExceeded");
    // a top-up that would push a over its own cap also reverts (1 already + 1.5 = 2.5 > 2)
    await expect(vault.connect(a).deposit({ value: E("1.5") })).to.be.revertedWithCustomError(vault, "CapExceeded");
  });

  // 3b) target overshoot is trimmed to the remaining gap and the surplus is refunded inline
  it("deposit overshoot: trims to the gap and refunds the surplus", async () => {
    // perWalletCap >= target so the cap never binds; only the target gap trims the deposit
    const { vault } = await openPresale({ target: E(3), perWalletCap: E(5), minContribution: E("0.1") });
    const [a, c] = [signers[3], signers[5]];

    await expect(vault.connect(a).deposit({ value: E(2) })).to.not.be.reverted; // room becomes 1 ETH
    expect(await vault.totalRaised()).to.equal(E(2));

    // c sends 2.5; only the 1 ETH gap is accepted, 1.5 ETH refunded in the same tx
    const spent = await ethDelta(c.address, vault.connect(c).deposit({ value: E("2.5") }));
    expect(await vault.contribution(c.address)).to.equal(E(1)); // rose only to the gap
    expect(await vault.totalRaised()).to.equal(E(3)); // == target
    // net ETH spent (gas already added back) is exactly the accepted 1 ETH, not 2.5 -> surplus refunded
    expect(-spent).to.equal(E(1));

    // target met -> further deposits revert TargetMet
    await expect(vault.connect(signers[6]).deposit({ value: E("0.5") })).to.be.revertedWithCustomError(vault, "TargetMet");
  });

  // 4) SUCCESS PATH: reach target, finalize (launch + pooled buy), pro-rata claims
  it("success path: three wallets fund, finalize launches+buys, depositors claim pro-rata", async () => {
    const { vault, vaultAddr, salts } = await openPresale({ target: E(3), perWalletCap: E(1), minContribution: E("0.1") });
    const ds = [signers[3], signers[4], signers[5]];
    for (const d of ds) await expect(vault.connect(d).deposit({ value: E(1) })).to.not.be.reverted;
    expect(await vault.totalRaised()).to.equal(E(3));
    expect(await vault.depositorCount()).to.equal(3n);

    // finalize (reveal salts). Permissionless: anyone with the preimage can call.
    await expect(vault.connect(signers[7]).finalize(salts.tokenSalt, salts.hookSalt, salts.curveSalt))
      .to.emit(vault, "Finalized");

    expect(await vault.state()).to.equal(1); // Launched
    const tokenAddr = await vault.token();
    expect(tokenAddr).to.not.equal(ZERO);
    const totalBought = await vault.totalTokensBought();
    expect(totalBought).to.be.gt(0n);

    const tok = await ethers.getContractAt("PadToken", tokenAddr);
    const totalRaised = await vault.totalRaised();
    const pooledSpent = await vault.pooledEthSpent();
    expect(pooledSpent).to.be.gt(0n);
    expect(pooledSpent).to.be.lte(totalRaised);

    let sumTokens = 0n;
    let prevTokenOut = null;
    for (const d of ds) {
      const [pvTok, pvEth] = await vault.previewClaim(d.address);
      expect(pvTok).to.be.gt(0n);
      // pro-rata: equal contributions => equal token allocation (within rounding)
      if (prevTokenOut !== null) expect(pvTok).to.equal(prevTokenOut);
      prevTokenOut = pvTok;

      const tokBefore = await tok.balanceOf(d.address);
      const ethBack = await ethDelta(d.address, vault.connect(d).claim());
      const tokAfter = await tok.balanceOf(d.address);

      expect(tokAfter - tokBefore).to.equal(pvTok); // received exactly the preview token amount
      expect(ethBack).to.equal(pvEth); // ETH-back matches preview (0 when the buy spent the whole raise)
      sumTokens += pvTok;

      // one-shot: a second claim reverts, and preview now reports nothing
      await expect(vault.connect(d).claim()).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
      expect((await vault.previewClaim(d.address))[0]).to.equal(0n);
    }
    // pro-rata payouts never exceed what was bought
    expect(sumTokens).to.be.lte(totalBought);
    // and they add up to the whole bag minus at most rounding dust (< #depositors)
    expect(totalBought - sumTokens).to.be.lt(BigInt(ds.length));
  });

  // 5) finalize guards
  it("finalize guards: wrong reveal -> BadReveal; below target -> TargetNotMet", async () => {
    // wrong reveal (target met first so BadReveal is the branch we hit)
    const met = await openPresale({ target: E(2), perWalletCap: E(2), minContribution: E("0.1") });
    await expect(met.vault.connect(signers[3]).deposit({ value: E(2) })).to.not.be.reverted;
    await expect(
      met.vault.finalize(ethers.id("wrong-token-salt"), met.salts.hookSalt, met.salts.curveSalt)
    ).to.be.revertedWithCustomError(met.vault, "BadReveal");

    // below target -> TargetNotMet (even with the correct reveal)
    const under = await openPresale({ target: E(3), perWalletCap: E(2), minContribution: E("0.1") });
    await expect(under.vault.connect(signers[3]).deposit({ value: E(1) })).to.not.be.reverted;
    await expect(
      under.vault.finalize(under.salts.tokenSalt, under.salts.hookSalt, under.salts.curveSalt)
    ).to.be.revertedWithCustomError(under.vault, "TargetNotMet");
  });

  // 6) FAIL PATH: under target at deadline -> fail(1) -> full refunds (one-shot)
  it("fail path: under target past deadline -> fail(reason 1), everyone refunds 100%", async () => {
    const now = await time.latest();
    const deadline = BigInt(now) + 2n * 86400n;
    const { vault } = await openPresale({ target: E(5), deadline, perWalletCap: E(2), minContribution: E("0.1") });
    const [a, b] = [signers[3], signers[4]];
    await expect(vault.connect(a).deposit({ value: E(1) })).to.not.be.reverted;
    await expect(vault.connect(b).deposit({ value: E("1.5") })).to.not.be.reverted;
    expect(await vault.totalRaised()).to.equal(E("2.5")); // under the 5 ETH target

    // before the deadline, fail() reverts
    await expect(vault.fail()).to.be.revertedWithCustomError(vault, "BeforeDeadline");

    await time.increaseTo(deadline + 10n);
    await expect(vault.fail()).to.emit(vault, "Failed").withArgs(1);
    expect(await vault.state()).to.equal(2); // Failed

    for (const [w, amt] of [[a, E(1)], [b, E("1.5")]]) {
      const got = await ethDelta(w.address, vault.connect(w).refund());
      expect(got).to.equal(amt); // 100% back
      // one-shot: second refund reverts
      await expect(vault.connect(w).refund()).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
    }
  });

  // 7) [L-13] ESCAPE HATCH is anchored to when the raise FILLED (filledAt), not the deadline: an early-filled raise's
  //    contributors aren't locked until a far-off deadline+grace. target met but never finalized -> fail(2) -> refunds.
  it("[L-13] escape hatch opens at filledAt+grace, well before a far deadline -> fail(reason 2), full refunds", async () => {
    const now = await time.latest();
    const deadline = BigInt(now) + 5n * 86400n; // a FAR deadline (5 days out)
    const grace = 86400n; // 1 day
    const { vault } = await openPresale({ target: E(3), deadline, perWalletCap: E(2), minContribution: E("0.1"), finalizeGrace: grace });
    const [a, b] = [signers[3], signers[4]];
    await expect(vault.connect(a).deposit({ value: E("1.5") })).to.not.be.reverted;
    await expect(vault.connect(b).deposit({ value: E("1.5") })).to.not.be.reverted;
    expect(await vault.totalRaised()).to.equal(E(3)); // target met — the raise CLOSED here
    const filledAt = await vault.filledAt();
    expect(filledAt).to.be.gt(0n); // [L-13] stamped the moment the raise filled

    // WITHIN grace of the FILL (and still far before the deadline): fail() reverts TargetMet (must finalize)
    await time.increaseTo(filledAt + grace / 2n);
    await expect(vault.fail()).to.be.revertedWithCustomError(vault, "TargetMet");

    // past filledAt+grace — but STILL BEFORE the far deadline — the escape hatch already opens (the L-13 improvement:
    // the OLD deadline-anchored hatch would have locked contributors until now+6 days; here it opens at now+1 day).
    await time.increaseTo(filledAt + grace + 10n);
    expect(BigInt(await time.latest())).to.be.lt(deadline); // proves the hatch opened BEFORE the deadline
    await expect(vault.fail()).to.emit(vault, "Failed").withArgs(2);
    expect(await vault.state()).to.equal(2);

    for (const [w, amt] of [[a, E("1.5")], [b, E("1.5")]]) {
      const got = await ethDelta(w.address, vault.connect(w).refund());
      expect(got).to.equal(amt);
    }
  });

  // 8) [audit] a contract contributor that can't receive plain ETH is stranded by refund() to itself, but the
  //    symmetric refundTo() (mirror of claimTo) rescues it — upholds "ETH is never trapped".
  it("refundTo: a no-receive contract contributor can still be made whole on the fail path", async () => {
    const now = await time.latest();
    const deadline = BigInt(now) + 2n * 86400n;
    const { vault, vaultAddr } = await openPresale({ target: E(5), deadline, perWalletCap: E(2), minContribution: E("0.1") });

    const dep = await (await ethers.getContractFactory("PresaleDepositor")).deploy();
    const depAddr2 = await dep.getAddress();
    await expect(dep.deposit(vaultAddr, { value: E(1) })).to.not.be.reverted; // the contract funds the presale
    expect(await vault.contribution(depAddr2)).to.equal(E(1));

    await time.increaseTo(deadline + 10n);
    await expect(vault.fail()).to.emit(vault, "Failed").withArgs(1);

    // refund() to the contract itself fails (no payable receive) — would strand the funds; the revert rolls back
    // the claimed flag, so the escape hatch is still available.
    await expect(dep.callRefund(vaultAddr)).to.be.revertedWithCustomError(vault, "EthSendFailed");

    // refundTo(EOA) rescues the full contribution
    const rescueTo = signers[8];
    const before = await ethers.provider.getBalance(rescueTo.address);
    await expect(dep.callRefundTo(vaultAddr, rescueTo.address)).to.not.be.reverted;
    expect((await ethers.provider.getBalance(rescueTo.address)) - before).to.equal(E(1));

    // one-shot: a second refund reverts (claimed flag now set)
    await expect(dep.callRefundTo(vaultAddr, rescueTo.address)).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
  });
});
