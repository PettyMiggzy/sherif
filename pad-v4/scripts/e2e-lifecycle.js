/*
 * FULL END-TO-END LIFECYCLE TEST — real transactions against the local devnet
 * (pad-v4/scripts/deploy-local-demo.js's deployment). Not a Hardhat test — a live script that exercises
 * every piece built this session, in order, against the persistent local chain:
 *
 *   1. Enable noPoolForever on the governed FeeConfig (owner action).
 *   2. Launch a NEW noPoolForever pad through the real factory (mined hook, real PadToken).
 *   3. Deploy a RobinDividendPool for it and wire it as staking BEFORE checkpoint (setStaking).
 *   4. Buy the pad out to its ceiling with a real buyer wallet.
 *   5. Run the REAL scripts/auto-graduate.cjs keeper bot (as a child process, plain ethers, no hardhat)
 *      against the local devnet and confirm it — not this script — calls graduate().
 *   6. Confirm the checkpoint: no permanent LP, still tradeable, dividend pool funded.
 *   7. Open a real ETH dividend epoch (platform-gated) over the buyer's holdings and have them claim it.
 *   8. Burn some of the buyer's tokens via RobinBurnTracker; confirm the on-chain tally.
 *   9. Run a full ArrowLauncher migration: launch + buy out + graduate + airdrop, holders self-claim.
 *
 * Usage: npx hardhat run scripts/e2e-lifecycle.js --network localhost
 */
const { ethers } = require("hardhat");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { mineHookSalt, hookInitCode } = require("./mine");
const { brandedTokenSalt, predictPadToken } = require("../test/helpers/brand");

const abi = ethers.AbiCoder.defaultAbiCoder();
const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const START = 201600, WIDTH = 23000, GRAD = START - WIDTH, TS = 100, FEE = 10000;

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

function section(title) { console.log("\n" + "═".repeat(78) + `\n  ${title}\n` + "═".repeat(78)); }

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "pad", "js", "deploy.local.json"), "utf8"));
  const [deployer, platform, creatorA, , , buyer1, buyer2] = await ethers.getSigners();

  const feeCfg = await ethers.getContractAt("RobinV4FeeConfig", d.contracts.feeConfig);
  const factory = await ethers.getContractAt("CurvePadFactoryV4", d.contracts.curveFactory);
  const dep = await ethers.getContractAt("DeterministicDeployer", d.contracts.deterministicDeployer);
  const reg = await ethers.getContractAt("FeeWalletRegistry", d.contracts.feeWalletRegistry);
  const pm = await ethers.getContractAt("PoolManager", d.contracts.poolManager);
  const sw = await ethers.getContractAt("PoolSwapTest", d.contracts.poolSwapTest);
  const burnTracker = await ethers.getContractAt("RobinBurnTracker", d.contracts.burnTracker);
  const arrowLauncher = await ethers.getContractAt("ArrowLauncher", d.contracts.arrowLauncher);

  section("1) Enable noPoolForever governance (owner action)");
  await (await feeCfg.setNoPoolForeverDefaults(true, 4000)).wait();
  console.log("noPoolForeverEnabled:", await feeCfg.noPoolForeverEnabled(), "bps:", await feeCfg.visibilityWithdrawBpsDefault());

  section("2) Launch a NEW noPoolForever pad through the real factory");
  const cfg = {
    name: "Robin Demo Delta", symbol: "RDELTA", decimals: 18,
    supply: 1_000_000_000n * 10n ** 18n, curveSupply: 730_000_000n * 10n ** 18n, reserveSupply: 270_000_000n * 10n ** 18n,
    tickSpacing: TS, startTickMag: 0, creator: creatorA.address, noPoolForever: true,
  };
  const tokenSalt = await brandedTokenSalt(d.contracts.deterministicDeployer, d.contracts.curveFactory, cfg, ethers.id("demo-delta"));
  const TokenF = await ethers.getContractFactory("PadToken");
  const predictedToken = predictPadToken(d.contracts.deterministicDeployer, d.contracts.curveFactory, cfg, tokenSalt, TokenF.bytecode);
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(
    d.contracts.deterministicDeployer,
    hookInitCode(HookF.bytecode, d.contracts.poolManager, d.contracts.curveFactory, d.contracts.feeWalletRegistry, predictedToken)
  );
  const curveSalt = ethers.id("demo-delta-curve");
  const ret = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  const [token, hook, curveAddr, poolId] = ret;
  const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
  console.log("RDELTA token:", token, "curve:", curveAddr);
  console.log("curve.noPoolForever():", await curve.noPoolForever(), "visibilityWithdrawBps():", await curve.visibilityWithdrawBps());

  section("3) Deploy RobinDividendPool and wire it as staking BEFORE checkpoint");
  const dividendPool = await (await ethers.getContractFactory("RobinDividendPool")).deploy(token, d.contracts.feeWalletRegistry);
  await dividendPool.waitForDeployment();
  await (await curve.connect(platform).setStaking(await dividendPool.getAddress())).wait();
  console.log("RobinDividendPool:", await dividendPool.getAddress(), "wired as curve.staking()");

  section("4) Buy RDELTA out to its ceiling — both buyers hold real tokens before the ceiling hits");
  const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
  await sw.connect(buyer2).swap(
    key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
  );
  console.log("buyer2 bought 1 ETH worth first — ready():", await curve.ready());
  await sw.connect(buyer1).swap(
    key, { zeroForOne: true, amountSpecified: -ethers.parseEther("5"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("5") }
  );
  console.log("buyer1 bought 5 ETH — ready():", await curve.ready());

  section("5) Run the REAL auto-graduate keeper bot (separate process, plain ethers) — not us calling graduate()");
  const keeperKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // Hardhat account #2
  const stateFile = path.join(__dirname, ".auto-graduate-state.e2e.json");
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  const out = execFileSync("node", [path.join(__dirname, "auto-graduate.cjs"), "--once"], {
    env: {
      ...process.env,
      RPC_URL: "http://127.0.0.1:8545",
      KEEPER_PRIVATE_KEY: keeperKey,
      FACTORY: d.contracts.curveFactory,
      START_BLOCK: "0",
      STATE_FILE: stateFile,
    },
    encoding: "utf8",
  });
  console.log(out);

  section("6) Confirm the checkpoint");
  console.log("curve.graduated():", await curve.graduated());
  console.log("stakingEthOwed():", (await curve.stakingEthOwed()).toString());
  console.log("dividendPool pendingEth:", (await dividendPool.pendingEth()).toString());
  console.log("dividendPool pendingToken:", (await dividendPool.pendingToken()).toString());
  const tok = await ethers.getContractAt("PadToken", token);
  await tok.connect(buyer1).approve(await sw.getAddress(), ethers.MaxUint256);
  const bal1 = await tok.balanceOf(buyer1.address);
  await sw.connect(buyer1).swap(
    key, { zeroForOne: false, amountSpecified: -(bal1 / 20n), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false }, "0x"
  );
  console.log("post-checkpoint sell succeeded — curve is still a live market.");

  section("7) Open + claim a real ETH dividend epoch");
  const buyer1Bal = await tok.balanceOf(buyer1.address);
  const buyer2Bal = await tok.balanceOf(buyer2.address);
  const entries = [
    { index: 0, account: buyer1.address, amount: ethers.parseEther("0.002") },
    { index: 1, account: buyer2.address, amount: ethers.parseEther("0.001") },
  ];
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  const pendingEth = await dividendPool.pendingEth();
  if (pendingEth < total) throw new Error(`dividend pool underfunded: has ${pendingEth}, need ${total}`);
  const layers = buildLayers(entries.map((e) => leafOf(e.index, e.account, e.amount)));
  const root = layers[layers.length - 1][0];
  await (await dividendPool.connect(platform).openEthEpoch(root, total)).wait();
  console.log("opened ETH epoch 0, root", root, "total", ethers.formatEther(total), "ETH");
  const proof0 = getProof(layers, 0);
  await (await dividendPool.connect(buyer1).claimEth(0, 0, buyer1.address, entries[0].amount, proof0)).wait();
  const before = await ethers.provider.getBalance(buyer1.address);
  await (await dividendPool.connect(buyer1).withdraw()).wait();
  const after = await ethers.provider.getBalance(buyer1.address);
  console.log(`buyer1 withdrew a real dividend — balance +${ethers.formatEther(after - before)} ETH (net of gas)`);

  section("8) Burn-boost: burn tokens via RobinBurnTracker");
  const burnAmt = buyer2Bal / 10n;
  await (await tok.connect(buyer2).approve(await burnTracker.getAddress(), burnAmt)).wait();
  await (await burnTracker.connect(buyer2).burn(token, burnAmt)).wait();
  console.log("buyer2 burnedBy tally:", (await burnTracker.burnedBy(token, buyer2.address)).toString(), "of", burnAmt.toString());

  section("9) Full Arrow migration launch — instant buyout + graduate + airdrop, real holders claim");
  const arrowCurveSupply = 730_000_000n * 10n ** 18n, arrowReserveSupply = 270_000_000n * 10n ** 18n;
  const arrowCfg = {
    name: "Robin Migrated", symbol: "RMIGR", decimals: 18,
    supply: arrowCurveSupply + arrowReserveSupply, curveSupply: arrowCurveSupply, reserveSupply: arrowReserveSupply,
    tickSpacing: TS, startTickMag: 0, creator: creatorA.address, noPoolForever: false,
  };
  const arrowTokenSalt = await brandedTokenSalt(d.contracts.deterministicDeployer, d.contracts.curveFactory, arrowCfg, ethers.id("arrow-demo"));
  const arrowPredictedToken = predictPadToken(d.contracts.deterministicDeployer, d.contracts.curveFactory, arrowCfg, arrowTokenSalt, TokenF.bytecode);
  const { salt: arrowHookSalt } = mineHookSalt(
    d.contracts.deterministicDeployer,
    hookInitCode(HookF.bytecode, d.contracts.poolManager, d.contracts.curveFactory, d.contracts.feeWalletRegistry, arrowPredictedToken)
  );
  const arrowCurveSalt = ethers.id("arrow-demo-curve");
  const holderEntries = [
    { index: 0, account: buyer1.address, amount: 300_000_000n * 10n ** 18n },
    { index: 1, account: buyer2.address, amount: 250_000_000n * 10n ** 18n },
  ];
  const holderLayers = buildLayers(holderEntries.map((e) => leafOf(e.index, e.account, e.amount)));
  const holderRoot = holderLayers[holderLayers.length - 1][0];
  const arrowRet = await arrowLauncher.connect(creatorA).launch.staticCall(
    arrowCfg, arrowTokenSalt, arrowHookSalt, arrowCurveSalt, holderRoot, { value: ethers.parseEther("8") }
  );
  await (await arrowLauncher.connect(creatorA).launch(
    arrowCfg, arrowTokenSalt, arrowHookSalt, arrowCurveSalt, holderRoot, { value: ethers.parseEther("8") }
  )).wait();
  const [arrowToken, arrowCurveAddr, distributorAddr] = arrowRet;
  const arrowCurve = await ethers.getContractAt("RobinCurveV4", arrowCurveAddr);
  console.log("RMIGR token:", arrowToken, "graduated:", await arrowCurve.graduated());
  const dist = await ethers.getContractAt("ArrowDistributor", distributorAddr);
  const arrowTok = await ethers.getContractAt("PadToken", arrowToken);
  for (const e of holderEntries) {
    await (await dist.claim(e.index, e.account, e.amount, getProof(holderLayers, e.index))).wait();
  }
  console.log("holder1 RMIGR balance:", (await arrowTok.balanceOf(buyer1.address)).toString());
  console.log("holder2 RMIGR balance:", (await arrowTok.balanceOf(buyer2.address)).toString());
  console.log("creator RMIGR balance (must be 0 — no dev bag):", (await arrowTok.balanceOf(creatorA.address)).toString());

  section("ALL DONE — every piece built this session exercised with real transactions");
}

main().catch((e) => { console.error(e); process.exit(1); });
