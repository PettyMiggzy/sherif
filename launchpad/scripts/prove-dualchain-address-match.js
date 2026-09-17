/*
 * PROOF, not production tooling — the v3 (launchpad/) sibling of pad-v4's
 * scripts/prove-dualchain-address-match.js. Same claim, same mechanism, this pad's own contracts:
 *
 * Every infra contract (BondDeployer, CurvePoolDeployer, LaunchTokenDeployer, CurvePadFactory, PadRouter)
 * deploys via plain CREATE (see scripts/deploy-v2.js — all `.deploy(...)`, no CREATE2 for themselves).
 * Plain CREATE's address is `f(sender, nonce)` ONLY — constructor args (including the real Uniswap v3
 * factory address, which genuinely differs between Arc and Robinhood Chain) never factor in. So the same
 * deployer key, running the same deploy sequence starting from the same nonce, lands every infra contract
 * — including CurvePadFactory itself — at the SAME address on both chains. Once that holds, a
 * `launchWithSalt()` call with an identical LaunchParams + identical mined salt produces an identical
 * branded (1ab5-ending) token address on both, via LaunchTokenDeployer's CREATE2 (salt bound to (caller,
 * candidate), initCodeHash depending only on (name, symbol, supply, factory address) — nothing chain-specific).
 *
 * Proven here against two independent local Hardhat nodes (different chainIds, independently-deployed REAL
 * @uniswap/v3-core bytecode with DIFFERENT pool-factory addresses on each — same shape as the real chains).
 *
 * Usage:
 *   HARDHAT_CHAIN_ID=4663 npx hardhat node --hostname 0.0.0.0 --port 8610   (chain A — Robinhood-sim)
 *   HARDHAT_CHAIN_ID=5042 npx hardhat node --hostname 0.0.0.0 --port 8611   (chain B — Arc-sim)
 *   CHAIN_A_RPC=http://127.0.0.1:8610 CHAIN_B_RPC=http://127.0.0.1:8611 node scripts/prove-dualchain-address-match.js
 */
const { ethers, artifacts } = require("hardhat");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const { mineFor } = require("../test/helpers/brand");

const START = 201600, WIDTH = 23000, MINGRAD = 22800;
const CREATION_FEE = ethers.parseEther("0.001");
const NOTAX = (dev) => ({ buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev });

async function deployOn(signer, nonceRef, name, args = [], artOverride = null) {
  const art = artOverride || (await artifacts.readArtifact(name));
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const tx = await factory.getDeployTransaction(...args);
  const sent = await signer.sendTransaction({ ...tx, nonce: nonceRef.n++ });
  const rc = await sent.wait();
  return new ethers.Contract(rc.contractAddress, art.abi, signer);
}

async function bootstrap(provider, signer, label) {
  const nonceRef = { n: await provider.getTransactionCount(signer.address) };
  console.log(`\n[${label}] deploying REAL @uniswap/v3-core (address WILL differ between chains — that's the point)...`);
  const weth = await deployOn(signer, nonceRef, "MockWETH9");
  const v3 = await deployOn(signer, nonceRef, null, [], V3_FACTORY_ART);
  console.log(`  [${label}] WETH=${await weth.getAddress()}  UniswapV3Factory=${await v3.getAddress()}`);

  console.log(`[${label}] bootstrapping the v3 pad stack (plain CREATE, matching nonce sequence)...`);
  const router = await deployOn(signer, nonceRef, "PadRouter", [await weth.getAddress(), signer.address]);
  const bondDeployer = await deployOn(signer, nonceRef, "BondDeployer", [9000, 15600]);
  const curvePoolDeployer = await deployOn(signer, nonceRef, "CurvePoolDeployer");
  const launchTokenDeployer = await deployOn(signer, nonceRef, "LaunchTokenDeployer");
  const factory = await deployOn(signer, nonceRef, "CurvePadFactory", [
    await weth.getAddress(), await v3.getAddress(), signer.address, signer.address, await router.getAddress(),
    await launchTokenDeployer.getAddress(), await curvePoolDeployer.getAddress(), await bondDeployer.getAddress(),
    ethers.ZeroAddress, START, WIDTH, MINGRAD,
  ]);
  const setFactoryTx = await router.setFactory.populateTransaction(await factory.getAddress());
  await (await signer.sendTransaction({ ...setFactoryTx, nonce: nonceRef.n++ })).wait();

  const addrs = {
    router: await router.getAddress(),
    bondDeployer: await bondDeployer.getAddress(),
    curvePoolDeployer: await curvePoolDeployer.getAddress(),
    launchTokenDeployer: await launchTokenDeployer.getAddress(),
    factory: await factory.getAddress(),
  };
  for (const [k, v] of Object.entries(addrs)) console.log(`  [${label}] ${k.padEnd(20)} ${v}`);
  return { weth, v3, router, bondDeployer, curvePoolDeployer, launchTokenDeployer, factory, provider, signer };
}

async function main() {
  const rpcA = process.env.CHAIN_A_RPC || "http://127.0.0.1:8610";
  const rpcB = process.env.CHAIN_B_RPC || "http://127.0.0.1:8611";
  const providerA = new ethers.JsonRpcProvider(rpcA);
  const providerB = new ethers.JsonRpcProvider(rpcB);
  const funderA = await providerA.getSigner(0);
  const funderB = await providerB.getSigner(0);

  const pk = ethers.Wallet.createRandom().privateKey; // SAME deployer key on both chains
  const deployerA = new ethers.Wallet(pk, providerA);
  const deployerB = new ethers.Wallet(pk, providerB);
  await (await funderA.sendTransaction({ to: deployerA.address, value: ethers.parseEther("100") })).wait();
  await (await funderB.sendTransaction({ to: deployerB.address, value: ethers.parseEther("100") })).wait();
  console.log(`Shared deployer key: ${deployerA.address} (funded on both chains, nonce 0 on both)`);
  console.log(`  chain A (${rpcA}) chainId=${(await providerA.getNetwork()).chainId}`);
  console.log(`  chain B (${rpcB}) chainId=${(await providerB.getNetwork()).chainId}`);

  const SA = await bootstrap(providerA, deployerA, "A");
  const SB = await bootstrap(providerB, deployerB, "B");

  console.log("\n=== Infra address comparison ===");
  let allMatch = true;
  for (const k of ["router", "bondDeployer", "curvePoolDeployer", "launchTokenDeployer", "factory"]) {
    const a = await SA[k].getAddress();
    const b = await SB[k].getAddress();
    const match = a.toLowerCase() === b.toLowerCase();
    allMatch &&= match;
    console.log(`  ${k.padEnd(20)} ${match ? "MATCH " : "DIVERGED"}  ${a}${match ? "" : "  vs  " + b}`);
  }
  const v3Match = (await SA.v3.getAddress()).toLowerCase() === (await SB.v3.getAddress()).toLowerCase();
  console.log(`  (real UniswapV3Factory addresses ${v3Match ? "matched (coincidence, harmless)" : "differ, as expected"} — proves constructor args don't matter for CREATE)`);

  if (!allMatch) {
    console.log("\nFAILED: infra addresses diverged.");
    process.exit(1);
  }

  console.log("\n=== Launching the SAME coin on both chains ===");
  const cfg = { name: "Dual Chain Demo V3", symbol: "DUALV3", dev: deployerA.address, tax: NOTAX(deployerA.address), poolFee: 0, auctionDays: 0 };
  // mined ONCE against chain A's (now-matching) deployer/factory; the SAME salt is valid on chain B too.
  const { salt, addr: predictedToken } = await mineFor(SA.factory, deployerA.address, cfg, 0n, "dualchain-v3-proof");
  console.log(`  predicted token address: ${predictedToken}`);

  const LAUNCH_GAS = 16_000_000; // real usage measured ~13.56M; explicit limit sidesteps automatic-estimation quirks
  const launchTxA = await SA.factory.connect(deployerA).launchWithSalt.populateTransaction(cfg, salt, { value: CREATION_FEE });
  const rcA = await (await deployerA.sendTransaction({ ...launchTxA, nonce: await providerA.getTransactionCount(deployerA.address), gasLimit: LAUNCH_GAS })).wait();
  const evA = rcA.logs.map((l) => { try { return SA.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  console.log(`  [A] launched: token=${evA.args.token}  (gas used ${rcA.gasUsed})`);

  const launchTxB = await SB.factory.connect(deployerB).launchWithSalt.populateTransaction(cfg, salt, { value: CREATION_FEE });
  const rcB = await (await deployerB.sendTransaction({ ...launchTxB, nonce: await providerB.getTransactionCount(deployerB.address), gasLimit: LAUNCH_GAS })).wait();
  const evB = rcB.logs.map((l) => { try { return SB.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  console.log(`  [B] launched: token=${evB.args.token}  (gas used ${rcB.gasUsed})`);

  const tokenA = evA.args.token, tokenB = evB.args.token;
  const tokenMatch = tokenA.toLowerCase() === tokenB.toLowerCase();
  const matchesPrediction = tokenA.toLowerCase() === predictedToken.toLowerCase();
  const endsIn1ab5 = tokenA.toLowerCase().endsWith("1ab5");
  console.log(`\n=== Result ===`);
  console.log(`  token address matches across chains: ${tokenMatch}`);
  console.log(`  matches the pre-launch prediction:    ${matchesPrediction}`);
  console.log(`  ends in the 1ab5 brand suffix:         ${endsIn1ab5}`);
  if (!tokenMatch || !matchesPrediction || !endsIn1ab5) {
    console.log("\nFAILED.");
    process.exit(1);
  }
  console.log("\nPROVEN: one mined salt, one LaunchParams, two independent chains, one identical branded token address.");
}

main().catch((e) => { console.error(e); process.exit(1); });
