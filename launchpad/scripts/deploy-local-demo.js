/*
 * LOCAL DEMO ONLY — deploys the full v3 pad stack (WETH mock + a real @uniswap/v3-core factory + PadRouter +
 * CurvePadFactory + the auction thin-deployers, wired on) to a local Hardhat node (chainId 31337, started with
 * `npx hardhat node`). Mirrors pad-v4/scripts/deploy-local-demo.js's role for this pad: gives `pad/`'s
 * daily-auction UI (create.html's auction picker, token.html's Auction panel) something real to talk to for
 * manual browser testing, via pad/e2e/auction-manual.mjs.
 *
 * `deploy-v2.js` is the real deploy path (v2-alongside-the-live-v1, reuses live infra) and is NOT what this
 * replaces — this is a from-scratch stack for a throwaway local chain, the v3 sibling of prove-dualchain-
 * address-match.js's bootstrap() plus the auction wiring that proof script deliberately leaves off (it isn't
 * the real deploy path either; deploy-v2.js already carries that fix separately).
 *
 * NEVER use this script's output against a real network — it uses Hardhat's publicly-known dev accounts and a
 * mock WETH.
 *
 * Usage:
 *   npx hardhat node                                       (separate terminal)
 *   npx hardhat run scripts/deploy-local-demo.js --network localhost
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

const START = 201600, WIDTH = 23000, MINGRAD = 22800;

async function deploy(name, args = [], artOverride = null) {
  const label = name || "UniswapV3Factory";
  const art = artOverride || (await ethers.getContractFactory(name));
  const c = artOverride
    ? await new ethers.ContractFactory(art.abi, art.bytecode, (await ethers.getSigners())[0]).deploy(...args)
    : await art.deploy(...args);
  await c.waitForDeployment();
  console.log(`  ${label.padEnd(28)} ${await c.getAddress()}`);
  return c;
}

async function main() {
  const [deployer, platform, dev, alice, bob] = await ethers.getSigners();
  console.log(`Deploying LOCAL DEMO v3 stack (chainId ${(await ethers.provider.getNetwork()).chainId}) as ${deployer.address}\n`);

  const weth = await deploy("MockWETH9");
  const v3 = await deploy(null, [], V3_FACTORY_ART);
  const router = await deploy("PadRouter", [await weth.getAddress(), deployer.address]);
  const bondDeployer = await deploy("BondDeployer", [9000, 15600]);
  const curvePoolDeployer = await deploy("CurvePoolDeployer");
  const launchTokenDeployer = await deploy("LaunchTokenDeployer");
  const factory = await deploy("CurvePadFactory", [
    await weth.getAddress(), await v3.getAddress(), platform.address, deployer.address, await router.getAddress(),
    await launchTokenDeployer.getAddress(), await curvePoolDeployer.getAddress(), await bondDeployer.getAddress(),
    ethers.ZeroAddress, START, WIDTH, MINGRAD,
  ]);
  await (await router.setFactory(await factory.getAddress())).wait();

  // The auction feature — same fix scripts/deploy-v2.js carries for the real deploy path, replicated here
  // since this is a fresh stack, not v2-alongside-v1.
  const robinStakingDeployer = await deploy("RobinStakingDeployer");
  const dailyAuctionVaultDeployer = await deploy("DailyAuctionVaultDeployer", [await robinStakingDeployer.getAddress()]);
  await (await factory.setAuctionVaultDeployer(await dailyAuctionVaultDeployer.getAddress())).wait();
  console.log(`  factory.setAuctionVaultDeployer(${await dailyAuctionVaultDeployer.getAddress()}) — auction feature ON`);

  const out = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rpcUrl: "http://127.0.0.1:8545",
    accounts: {
      // No private keys recorded — a real `npx hardhat node` process signs for its own default accounts on
      // plain eth_sendTransaction (it holds their keys itself), so a browser-automation mock wallet just
      // proxies eth_sendTransaction straight to the node with `from` set to one of these.
      deployer: deployer.address, platform: platform.address, dev: dev.address, alice: alice.address, bob: bob.address,
    },
    contracts: {
      weth: await weth.getAddress(), v3Factory: await v3.getAddress(), router: await router.getAddress(),
      bondDeployer: await bondDeployer.getAddress(), curvePoolDeployer: await curvePoolDeployer.getAddress(),
      launchTokenDeployer: await launchTokenDeployer.getAddress(), factory: await factory.getAddress(),
      robinStakingDeployer: await robinStakingDeployer.getAddress(),
      dailyAuctionVaultDeployer: await dailyAuctionVaultDeployer.getAddress(),
    },
  };
  // Deliberately NOT pad/js/deploy.local.json — pad-v4's own deploy-local-demo.js already writes that
  // filename for its (differently-shaped) no-pool-forever local harness; colliding would silently break it.
  const file = path.join(__dirname, "..", "..", "pad", "js", "deploy.v3-local.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
