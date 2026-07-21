/* eslint-disable no-console */
// Deploys a COMPLETE, self-contained pad stack to a PLAIN hardhat node (no fork) for the headless E2E.
//
// The launch flow needs a real Uniswap v3 factory + a WETH. On the fork those exist on-chain; here we deploy
// them locally: a genuine `UniswapV3Factory` from the @uniswap/v3-core artifact (chain-agnostic bytecode — the
// same contract Robinhood Chain runs) plus the repo's MockWETH9. Everything else mirrors scripts/deploy.js so the
// stack the browser talks to is byte-for-byte the production wiring. Addresses are written to $E2E_OUT as JSON.
//
//   npx hardhat run scripts/e2e-deploy.cjs --network localhost   (E2E_OUT=<path> set by e2e/run.mjs)
const { ethers, network } = require("hardhat");
const fs = require("fs");
const V3 = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

// Production geometry (identical to scripts/deploy.js defaults) so the E2E exercises the real curve, not a toy.
const START_TICK_MAG = Number(process.env.START_TICK_MAG || 207400);
const CURVE_WIDTH = Number(process.env.CURVE_WIDTH || 38000);
const MIN_GRAD_WIDTH = Number(process.env.MIN_GRAD_WIDTH || 27000);

async function main() {
  const [deployer] = await ethers.getSigners();
  const owner = deployer.address;
  const dep = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  // ── infra the launch flow assumes already exists on Robinhood Chain ──────────
  const weth = await dep("MockWETH9");
  const v3Factory = await new ethers.ContractFactory(V3.abi, V3.bytecode, deployer).deploy();
  await v3Factory.waitForDeployment();
  const WETH = await weth.getAddress();
  const V3FAC = await v3Factory.getAddress();

  // ── the pad stack (mirror of scripts/deploy.js) ─────────────────────────────
  const ltd = await dep("LaunchTokenDeployer");
  const cpd = await dep("CurvePoolDeployer");
  const bd = await dep("BondDeployer");
  const router = await dep("PadRouter", WETH, owner);
  const factory = await dep(
    "CurvePadFactory",
    WETH, V3FAC, owner /*platform*/, owner, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
    START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
  );
  await (await router.setFactory(await factory.getAddress())).wait();

  const rewardVault = await dep(
    "RewardVault",
    await router.getAddress(), owner /*poster*/, owner /*guardian*/,
    7 * 24 * 3600, 24 * 3600, 2 * 24 * 3600, 30 * 24 * 3600, owner
  );
  await (await router.setRewardVault(await rewardVault.getAddress())).wait();

  const floorFactory = await dep("FloorCoopFactory", WETH, V3FAC, owner);
  const splitter = await dep("PlatformFeeSplitter", owner, owner);

  const out = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    weth: WETH,
    v3Factory: V3FAC,
    padRouter: await router.getAddress(),
    padFactory: await factory.getAddress(),
    rewardVault: await rewardVault.getAddress(),
    floorCoopFactory: await floorFactory.getAddress(),
    platformSplitter: await splitter.getAddress(),
  };
  const dest = process.env.E2E_OUT || "e2e-addresses.json";
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log("E2E_DEPLOYED " + JSON.stringify(out));
  console.log(`network=${network.name} chainId=${out.chainId} → wrote ${dest}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
