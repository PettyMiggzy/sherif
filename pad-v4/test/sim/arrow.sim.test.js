const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { bindSalt, brandedTokenSalt } = require("../helpers/brand");

// SIM — Arrow migration launcher end to end, on a REAL local Uniswap v4 stack.
// A dev arrives with ETH + a committed merkle root of their holders. In ONE tx ArrowLauncher.launch:
//   0.5 ETH off top -> platform; launch the curve; buy out the WHOLE curve (lands spot exactly at gradSqrt);
//   graduate (LP locked); hand the bought supply to a no-withdraw ArrowDistributor; refund the dev's ETH change.
// The dev ends holding ZERO tokens; holders self-claim from the distributor.
// Reuses the exact deployStack + salt/predict/mine harness from the presale/e2e sims.

const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));
const ONE = 10n ** 18n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
// production geometry (from curve.calibration.sim): ~4.2 ETH to fill the whole curve, 1B supply @ 73%/27%.
const START = 201600, WIDTH = 23000, GRAD = START - WIDTH, TS = 100, FEE = 10000, MINGRAD = 22800;
const CURVE = 730_000_000n * ONE, RESERVE = 270_000_000n * ONE, SUPPLY = CURVE + RESERVE;

// ── merkle helpers (match ArrowDistributor: double-hashed leaf + OZ sorted-pair verify) ──
function leafOf(index, account, amount) {
  return ethers.keccak256(ethers.concat([ethers.keccak256(abi.encode(["uint256", "address", "uint256"], [index, account, amount]))]));
}
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}
function buildLayers(leaves) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const top = layers[layers.length - 1], next = [];
    for (let i = 0; i < top.length; i += 2) next.push(i + 1 < top.length ? hashPair(top[i], top[i + 1]) : top[i]);
    layers.push(next);
  }
  return layers;
}
function getProof(layers, index) {
  const proof = []; let idx = index;
  for (let l = 0; l < layers.length - 1; l++) { const p = idx ^ 1; if (p < layers[l].length) proof.push(layers[l][p]); idx >>= 1; }
  return proof;
}

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
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 0, buyBufferShareBps: 2000, referralShareBps: 0,
    platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
    lpFee: FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: MINGRAD,
    // [FDV] band deliberately OPEN in this fixture: these tests exercise curve mechanics over many toy
    // supplies, not the product's valuation policy. The band itself is proven in FDV.creator-supply.test.js.
    minFdvWei: 1n, maxFdvWei: 1_000_000n * 10n ** 18n, // = HARD_MAX_FDV_WEI
  });
  const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
  );
  await lockVault.setFactory(await factory.getAddress());
  return { pm, stateView, dep, reg, permit2, posm, lockVault, factory, feeCfg };
}

describe("SIM — Arrow migration launcher (buy out curve, graduate, airdrop to holders)", () => {
  let deployer, platform, dev, h1, h2, h3, stranger, S, launcher;
  let factoryAddr, depAddr, pmAddr, regAddr, tagN = 0;

  before(async () => {
    [deployer, platform, dev, h1, h2, h3, stranger] = await ethers.getSigners();
    S = await deployStack(deployer, platform);
    launcher = await (await ethers.getContractFactory("ArrowLauncher")).deploy(
      await S.factory.getAddress(), await S.reg.getAddress()
    );
    factoryAddr = await S.factory.getAddress();
    depAddr = await S.dep.getAddress();
    pmAddr = await S.pm.getAddress();
    regAddr = await S.reg.getAddress();
  });

  function makeCfg(tag, curveSupply, reserveSupply) {
    return { name: "Arrow " + tag, symbol: tag, decimals: 18, supply: curveSupply + reserveSupply, curveSupply, reserveSupply, tickSpacing: TS, startTickMag: 0, creator: dev.address };
  }
  async function prepareSalts(tag, cfg) {
    // [brand] the pad token address must end in `1ab5` or CurvePadFactoryV4 (which ArrowLauncher launches
    // through) reverts BadTokenSuffix — mine the salt from the EXACT cfg being launched, against the CURVE
    // FACTORY (the token's mintTo), not the launcher. The per-tag base salt keeps same-shape pads distinct.
    const tokenSalt = await brandedTokenSalt(depAddr, factoryAddr, cfg, ethers.id("tok-" + tag));
    const curveSalt = ethers.id("curve-" + tag);
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenInit = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, factoryAddr])]);
    const predictedToken = ethers.getCreate2Address(depAddr, bindSalt(cfg, tokenSalt), ethers.keccak256(tokenInit));
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(depAddr, hookInitCode(HookF.bytecode, pmAddr, factoryAddr, regAddr, predictedToken));
    return { tokenSalt, hookSalt, curveSalt };
  }

  it("launches, buys out the whole curve, graduates, and airdrops the supply — dev ends at zero", async () => {
    const tag = "ARW" + (tagN++);
    const cfg = makeCfg(tag, CURVE, RESERVE);
    const salts = await prepareSalts(tag, cfg);

    // holder snapshot summing just UNDER the curve supply (leaves a small locked remainder; production commits
    // to the deterministic curveSupply). 300M + 250M + 179M = 729M < 730M curve.
    const entries = [
      { index: 0, account: h1.address, amount: 300_000_000n * ONE },
      { index: 1, account: h2.address, amount: 250_000_000n * ONE },
      { index: 2, account: h3.address, amount: 179_000_000n * ONE },
    ];
    const claimSum = entries.reduce((s, e) => s + e.amount, 0n);
    const layers = buildLayers(entries.map((e) => leafOf(e.index, e.account, e.amount)));
    const root = layers[layers.length - 1][0];

    const platformEthBefore = await ethers.provider.getBalance(platform.address);

    const res = await launcher.connect(dev).launch.staticCall(cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, root, { value: E(8) });
    const [token, curve, distributor] = [res[0], res[1], res[2]];
    await (await launcher.connect(dev).launch(cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, root, { value: E(8) })).wait();

    const tok = await ethers.getContractAt("PadToken", token);
    const curveC = await ethers.getContractAt("RobinCurveV4", curve);
    const dist = await ethers.getContractAt("ArrowDistributor", distributor);

    // graduation happened (LP minted + locked)
    expect(await curveC.graduated()).to.equal(true);
    // the dev holds ZERO token — no bag
    expect(await tok.balanceOf(dev.address)).to.equal(0n);
    // the launcher retains ZERO token (the whole bought supply moved to the distributor)
    expect(await tok.balanceOf(await launcher.getAddress())).to.equal(0n);
    // the platform got EXACTLY the 0.5 ETH flat fee and ZERO token (ETH only)
    expect(await ethers.provider.getBalance(platform.address)).to.equal(platformEthBefore + E("0.5"));
    expect(await tok.balanceOf(platform.address)).to.equal(0n);
    // the bought supply sits in the distributor, committed to the holder root
    const inDist = await tok.balanceOf(distributor);
    expect(inDist).to.be.gte(claimSum); // enough to cover every committed holder
    expect(await dist.merkleRoot()).to.equal(root);

    // holders self-claim
    for (const e of entries) {
      await dist.connect(h1).claim(e.index, e.account, e.amount, getProof(layers, e.index)); // anyone can trigger
      expect(await tok.balanceOf(e.account)).to.equal(e.amount);
    }
    // distributor drained to the locked remainder (bought - claimSum); no withdraw path exists for it
    expect(await tok.balanceOf(distributor)).to.equal(inDist - claimSum);
    expect(await dist.totalClaimed()).to.equal(claimSum);
  });

  it("reverts a launch that doesn't cover the platform fee, or underfunds the buyout", async () => {
    const tag = "ARW" + (tagN++);
    const cfg = makeCfg(tag, CURVE, RESERVE);
    const salts = await prepareSalts(tag, cfg);
    const root = ethers.id("some-root");
    // below the flat platform fee
    await expect(launcher.connect(dev).launch(cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, root, { value: E("0.3") }))
      .to.be.revertedWithCustomError(launcher, "BelowPlatformFee");
    // covers the fee but not the full-curve buyout
    await expect(launcher.connect(dev).launch(cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, root, { value: E("0.6") }))
      .to.be.revertedWithCustomError(launcher, "UnderfundedBuyout");
    // empty root
    await expect(launcher.connect(dev).launch(cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, ethers.ZeroHash, { value: E(60) }))
      .to.be.revertedWithCustomError(launcher, "EmptyRoot");
  });

  // ── adversarial ──────────────────────────────────────────────────────────────────

  it("gates unlockCallback to the pool manager — a stranger cannot drive a rogue swap through the launcher", async () => {
    const key = { currency0: ZERO, currency1: dev.address, fee: FEE, tickSpacing: TS, hooks: ZERO };
    const data = abi.encode(["uint256", "tuple(address,address,uint24,int24,address)", "uint160"],
      [1n, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], 1n]);
    await expect(launcher.connect(dev).unlockCallback(data)).to.be.revertedWithCustomError(launcher, "NotPoolManager");
  });

  it("a contract dev that cannot receive ETH bricks only its OWN launch — atomic revert, no funds lost", async () => {
    const tag = "ARW" + (tagN++);
    const cfg = makeCfg(tag, CURVE, RESERVE);
    const salts = await prepareSalts(tag, cfg);
    const root = ethers.id("holder-root");
    const rejectDev = await (await ethers.getContractFactory("ArrowRejectDev")).deploy();

    // the launcher's ETH refund send to this contract (no receive()) fails → the whole launch reverts atomically.
    const data = launcher.interface.encodeFunctionData("launch", [cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, root]);
    await expect(rejectDev.doLaunch(await launcher.getAddress(), data, { value: E(8) }))
      .to.be.revertedWithCustomError(launcher, "EthSendFailed");
    // nothing was left stranded: the reverted tx returns all the ETH; the launcher holds none, no pad exists
    expect(await ethers.provider.getBalance(await launcher.getAddress())).to.equal(0n);
  });

  it("leaves ZERO ETH residue in the singleton launcher after a successful launch (change all refunded)", async () => {
    const tag = "ARW" + (tagN++);
    const cfg = makeCfg(tag, CURVE, RESERVE);
    const salts = await prepareSalts(tag, cfg);
    const root = ethers.id("holders-" + tag);
    await (await launcher.connect(dev).launch(cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, root, { value: E(9) })).wait();
    // the launcher is a singleton reused across launches — it must never accrue ETH (or a later dev could sweep it)
    expect(await ethers.provider.getBalance(await launcher.getAddress())).to.equal(0n);
  });

  it("[audit M1] a donation to the singleton is NOT swept to the next dev's refund — only this launch's change is refunded", async () => {
    // an attacker force-sends ETH into the launcher hoping the next dev sweeps it
    await stranger.sendTransaction({ to: await launcher.getAddress(), value: E(3) });
    expect(await ethers.provider.getBalance(await launcher.getAddress())).to.equal(E(3));

    const tag = "ARW" + (tagN++);
    const cfg = makeCfg(tag, CURVE, RESERVE);
    const salts = await prepareSalts(tag, cfg);
    const root = ethers.id("holders-" + tag);
    const devBefore = await ethers.provider.getBalance(dev.address);
    const rc = await (await launcher.connect(dev).launch(cfg, salts.tokenSalt, salts.hookSalt, salts.curveSalt, root, { value: E(9) })).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const devAfter = await ethers.provider.getBalance(dev.address);

    // the donated 3 ETH STAYS in the launcher (not handed to the dev)
    expect(await ethers.provider.getBalance(await launcher.getAddress())).to.equal(E(3));
    // the dev's net spend is 0.5 (platform) + buyout, plus gas — NOT reduced by the donation. So the dev spent
    // strictly MORE than the 0.5 fee (they didn't pocket the 3 ETH), and less than the full 9 (change refunded).
    const netSpent = devBefore - devAfter - gas;
    expect(netSpent).to.be.gt(E("0.5")); // paid fee + buyout, did NOT receive the 3 ETH donation
    expect(netSpent).to.be.lt(E(9));     // got real change back
  });
});
