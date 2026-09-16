/*
 * Bootstrap the Robin V4 "curve-on-V4" suite on ARC MAINNET (chainId 5042). Sibling of
 * deploy-curve.js (Robinhood Chain) — same contracts, same fee-economics percentages, but with:
 *   1. Arc's real Uniswap v4 addresses (PoolManager is identical to Robinhood Chain's — both land
 *      at the same CREATE2 address via Uniswap's canonical cross-chain deployer; PositionManager
 *      differs per chain and MUST be the Arc-specific one below, verified against Uniswap's own
 *      published deployments list).
 *   2. RECALIBRATED absolute-price constants (startTickMag, minFdvWei, maxFdvWei). Arc's native
 *      currency (USDC, 18-decimal native interface — msg.value/gas, same mechanics as ETH) is worth
 *      ~$1/unit. Robinhood Chain's startTickMag=201600 was tuned assuming ETH ~= $1,932/unit; copied
 *      unchanged onto Arc it would graduate a pad on ~$4 raised instead of the intended ~$7,800 — a
 *      broken product, not a cosmetic difference. See scripts/deploy-arc-demo.js's header comment for
 *      the full derivation; startTickMag=125900 here reproduces the IDENTICAL $3,400-start /
 *      $34,000-graduate real-dollar curve, verified live on a local devnet (startTick/gradTick landed
 *      exactly as computed). curveWidth/minGradWidth are UNCHANGED — that's the start-to-graduation
 *      ratio (~10x), which is currency-agnostic.
 *   3. NORMAL (EIP-1559) transactions, not legacy type-0 — Arc supports EIP-1559 natively (unlike
 *      Robinhood Chain's Orbit stack, which is why deploy-curve.js forces type:0).
 *
 * Order (each depends on the prior) — identical to deploy-curve.js:
 *   DeterministicDeployer → RobinStateView → FeeWalletRegistry → LockVault → CurveV4Deployer
 *     → RobinV4FeeConfig (governed v2 defaults) → CurvePadFactoryV4 → lockVault.setFactory
 *
 * The FeeConfig defaults are FORWARD-ONLY governance: retune them for FUTURE launches with
 * feeConfig.setDefaults(...) — never a factory redeploy. Live pads keep the fee they were born with.
 *
 * Post-deploy (out of band): transfer FeeWalletRegistry + RobinV4FeeConfig ownership to the platform
 * multisig (both Ownable2Step), then run  FACTORY=<curveFactory> node scripts/auto-verify.cjs --once
 * (pointed at Arc's Blockscout explorer, not Robinhood Chain's).
 *
 * REQUIRES A FUNDED DEPLOYER WALLET WITH REAL USDC ON ARC — this is Arc mainnet, real money, day one
 * of a brand-new chain. Do not run this until that wallet exists and the platform operator has
 * explicitly signed off on going live.
 *
 * Usage: ARC_RPC=<rpc> PRIVATE_KEY=<key> PLATFORM_WALLET=<addr> \
 *        npx hardhat run scripts/deploy-curve-arc.js --network arc
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Uniswap v4 dependency addresses on ARC MAINNET (chainId 5042) — verified against Uniswap's official
// deployments list (developers.uniswap.org/contracts/v4/deployments) on 2026-09-16, the chain's launch day.
const POOL_MANAGER = process.env.POOL_MANAGER || "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = process.env.POSITION_MANAGER || "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B";
const PERMIT2 = process.env.PERMIT2 || "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Governed v3-economics DEFAULT launch params — IDENTICAL fee-economics percentages to Robinhood
// Chain (deploy-curve.js), RECALIBRATED absolute-price constants (see file header). Magnitudes are
// tick-spacing-aligned for ts=100 (125900/100, 23000/100, 22800/100 are integers) — launches must
// pass tickSpacing=100.
const DEFAULTS = {
  // [fee-model] Same 1%/1% split as Robinhood Chain — see deploy-curve.js's comment block for the
  // exact buy/sell fee breakdown; nothing here is currency-dependent, only the tax rate itself.
  buyTaxBps: Number(process.env.BUY_TAX_BPS || 100),
  sellTaxBps: Number(process.env.SELL_TAX_BPS || 100),
  sellFloorShareBps: Number(process.env.SELL_FLOOR_SHARE_BPS || 0),
  buyLpFloorShareBps: Number(process.env.BUY_LP_FLOOR_SHARE_BPS || 0),
  buyBufferShareBps: Number(process.env.BUY_BUFFER_SHARE_BPS || 2000),
  referralShareBps: Number(process.env.REFERRAL_SHARE_BPS || 2500),
  platformGradBps: Number(process.env.PLATFORM_GRAD_BPS || 1000),
  creatorGradBps: Number(process.env.CREATOR_GRAD_BPS || 1000),
  ambushGradBps: Number(process.env.AMBUSH_GRAD_BPS || 1500),
  lpFee: Number(process.env.LP_FEE || 10000), // 1% static pool LP fee
  // [RECALIBRATED] 201600 (Robinhood/ETH) -> 125900 (Arc/USDC). Reproduces the identical $3,400
  // start FDV / $34,000 graduation FDV real-dollar curve — see deploy-arc-demo.js header for the math.
  startTickMag: Number(process.env.START_TICK_MAG || 125900),
  curveWidth: Number(process.env.CURVE_WIDTH || 23000), // UNCHANGED — ratio, not absolute price (~10x)
  minGradWidth: Number(process.env.MIN_GRAD_WIDTH || 22800), // UNCHANGED — informational marker
  // [RECALIBRATED] 0.05-100 ETH ($97-$193,200 at the ETH price deploy-curve.js's defaults implied)
  // -> ~100-200000 native-USDC-equivalent units (still parseEther — that's just "18-decimal units",
  // and Arc's native 18-decimal interface uses the exact same math). Arc's native currency being
  // dollar-pegged means these are now literally their own USD value — no price-assumption drift risk
  // the way Robinhood Chain's ETH-denominated bounds have ("RETUNE THESE as ETH moves").
  minFdvWei: ethers.parseEther(process.env.MIN_FDV_USD || "100"),
  maxFdvWei: ethers.parseEther(process.env.MAX_FDV_USD || "200000"),
};

async function deploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(24)} ${await c.getAddress()}`);
  return c;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const platform = process.env.PLATFORM_WALLET;
  if (!platform) throw new Error("PLATFORM_WALLET must be set (the platform fee wallet + root admin — never the hot deploy key)");

  const liveChainId = Number((await ethers.provider.getNetwork()).chainId);
  if (liveChainId !== 5042) {
    throw new Error(`Refusing to deploy: connected chainId is ${liveChainId}, expected Arc mainnet (5042). ` +
      `Check ARC_RPC / --network before running this against real funds.`);
  }
  console.log(`Deploying Robin V4 curve suite to ARC MAINNET as ${deployer.address} (platform wallet ${platform})\n`);

  const dep = await deploy("DeterministicDeployer");
  const stateView = await deploy("RobinStateView", [POOL_MANAGER]);
  const reg = await deploy("FeeWalletRegistry", [platform, deployer.address]);
  const lockVault = await deploy("LockVault", [POSITION_MANAGER, await reg.getAddress()]);
  const curveDeployer = await deploy("CurveV4Deployer", [await dep.getAddress()]);
  const feeConfig = await deploy("RobinV4FeeConfig", [deployer.address, DEFAULTS]);
  const factory = await deploy("CurvePadFactoryV4", [
    POOL_MANAGER,
    POSITION_MANAGER,
    PERMIT2,
    await stateView.getAddress(),
    await dep.getAddress(),
    await curveDeployer.getAddress(),
    await feeConfig.getAddress(),
    await reg.getAddress(),
    await lockVault.getAddress(),
  ]);

  const setTx = await lockVault.setFactory(await factory.getAddress());
  const rc = await setTx.wait();
  console.log(`  lockVault.setFactory -> ${await factory.getAddress()}\n`);

  const curveFactory = await factory.getAddress();

  const presaleImpl = await deploy("PresaleVault");
  const presaleFactory = await deploy("PresaleVaultFactory", [curveFactory, await presaleImpl.getAddress()]);
  const out = {
    chainId: 5042,
    deployer: deployer.address,
    platformWallet: platform,
    poolManager: POOL_MANAGER,
    positionManager: POSITION_MANAGER,
    permit2: PERMIT2,
    curveFactoryBlock: rc.blockNumber,
    defaults: DEFAULTS,
    contracts: {
      deterministicDeployer: await dep.getAddress(),
      stateView: await stateView.getAddress(),
      feeWalletRegistry: await reg.getAddress(),
      lockVault: await lockVault.getAddress(),
      curveDeployer: await curveDeployer.getAddress(),
      feeConfig: await feeConfig.getAddress(),
      curveFactory,
      presaleImpl: await presaleImpl.getAddress(),
      presaleFactory: await presaleFactory.getAddress(),
    },
  };
  const file = path.join(__dirname, "..", "deploy.curve.arc.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
  console.log("\nNext (identical checklist to the Robinhood Chain deploy, see deploy-curve.js):");
  console.log("  1. transfer FeeWalletRegistry + RobinV4FeeConfig ownership to the platform multisig (Ownable2Step)");
  console.log(`  2. FACTORY=${curveFactory} node scripts/auto-verify.cjs --once   (point it at Arc's Blockscout: https://explorer.arc.io)`);
  console.log("  3. per launched pad: RobinLockStaking for holder staking; at/near graduation deploy RobinFloorVault +");
  console.log("     RobinAmbushVault, wire curve.setStaking/setFloor/setAmbush AND hook.setFloorRecipient (two separate");
  console.log("     floor wirings — missing hook.setFloorRecipient means every sell's floor carve goes nowhere).");
  console.log("     ORDERING: curve.setStaking() MUST be called BEFORE graduate() or the LP-lock's fee recipient wiring");
  console.log("     breaks. Run `node scripts/check-wiring.js` after graduation to confirm all five are set.");
  console.log("  4. presales (optional): presaleFactory.createPresale(...) — see deploy-curve.js's own note.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
