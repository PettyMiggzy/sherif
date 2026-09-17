/*
 * PROOF, not production tooling: demonstrates that the SAME token address (always ending in the `1ab5`
 * brand suffix) lands on TWO INDEPENDENT chains when the pad-v4 stack is bootstrapped identically on each.
 *
 * THE CLAIM: nothing in this codebase needs new Solidity to make this true. Every infra contract
 * (DeterministicDeployer, RobinStateView, FeeWalletRegistry, LockVault, CurveV4Deployer, RobinV4FeeConfig,
 * CurvePadFactoryV4) is deployed via plain CREATE (see scripts/deploy-curve.js / deploy-curve-arc.js — both
 * use `.deploy(...)`, never DeterministicDeployer/CREATE2, for THEMSELVES). Plain CREATE's address is
 * `f(sender, nonce)` ONLY — constructor arguments never factor in. So:
 *   - Two chains' real Uniswap v4 infra addresses (PoolManager/PositionManager/Permit2) being DIFFERENT
 *     never breaks address matching — they're only ever constructor args here.
 *   - What DOES have to match is the DEPLOY SEQUENCE: the same deployer key, executing the exact same
 *     contracts in the exact same order, starting from the exact same nonce, on each chain.
 * Once CurvePadFactoryV4 itself lands at a matching address on both chains, a `launch()` call with an
 * IDENTICAL LaunchConfig + identical (tokenSalt, hookSalt, curveSalt) produces an IDENTICAL token address on
 * both — CREATE2 through DeterministicDeployer, whose address now matches too, with initCodeHash depending
 * on (name, symbol, decimals, supply, factory address) — nothing chain-specific. The creator mines the salt
 * ONCE; it's valid on every chain the stack is mirrored on.
 *
 * This script proves it empirically against TWO separate local Hardhat nodes (simulating Arc + Robinhood
 * Chain — different chainIds, independently-deployed MOCK Uniswap v4 infra with DIFFERENT addresses on each,
 * exactly like the real chains), not by assertion. It does NOT touch any real chain and needs no funds.
 *
 * Usage:
 *   HARDHAT_CHAIN_ID=4663 npx hardhat node --hostname 0.0.0.0 --port 8610   (chain "A" — Robinhood-sim)
 *   HARDHAT_CHAIN_ID=5042 npx hardhat node --hostname 0.0.0.0 --port 8611   (chain "B" — Arc-sim)
 *   CHAIN_A_RPC=http://127.0.0.1:8610 CHAIN_B_RPC=http://127.0.0.1:8611 node scripts/prove-dualchain-address-match.js
 */
const { ethers, artifacts } = require("hardhat");
const { mineHookSalt, hookInitCode } = require("./mine");
const { brandedTokenSalt, predictPadToken } = require("../test/helpers/brand");

const START = 201600, WIDTH = 23000, MINGRAD = 22800, TS = 100, LP_FEE = 10000;
const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 0, buyBufferShareBps: 2000,
  referralShareBps: 2500, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 1500,
  lpFee: LP_FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: MINGRAD,
  minFdvWei: ethers.parseEther("0.05"), maxFdvWei: ethers.parseEther("100"),
};

// Explicit, caller-tracked nonce rather than relying on ethers' automatic "pending" nonce lookup per send —
// hardhat's automining plus several back-to-back sends from a brand-new signer surfaced a nonce-desync
// (NONCE_EXPIRED) that explicit sequencing avoids outright.
async function deployOn(provider, signer, nonceRef, name, args = []) {
  const art = await artifacts.readArtifact(name);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const tx = await factory.getDeployTransaction(...args);
  const sent = await signer.sendTransaction({ ...tx, nonce: nonceRef.n++ });
  const rc = await sent.wait();
  return new ethers.Contract(rc.contractAddress, art.abi, signer);
}

/// The SAME sequence deploy-curve.js / deploy-curve-arc.js run, in one place, used identically for both
/// chains here — the actual guarantee this proof depends on. (Those two production scripts currently
/// duplicate this sequence independently; keeping it in lockstep by hand is a real drift risk worth fixing
/// separately — noted, not fixed here, since that's a refactor of live deploy tooling, out of scope for a
/// local proof.)
async function bootstrap(provider, signer, label) {
  const nonceRef = { n: await provider.getTransactionCount(signer.address) };
  console.log(`\n[${label}] bootstrapping mock Uniswap v4 infra (addresses WILL differ between chains — that's the point)...`);
  const pm = await deployOn(provider, signer, nonceRef, "PoolManager", [signer.address]);
  const permit2 = await deployOn(provider, signer, nonceRef, "MockPermit2");
  const posm = await deployOn(provider, signer, nonceRef, "MockPositionManagerV4", [await pm.getAddress(), await permit2.getAddress()]);
  console.log(`  [${label}] PoolManager=${await pm.getAddress()}  PositionManager=${await posm.getAddress()}  Permit2=${await permit2.getAddress()}`);

  console.log(`[${label}] bootstrapping the pad-v4 stack (plain CREATE, matching nonce sequence)...`);
  const dep = await deployOn(provider, signer, nonceRef, "DeterministicDeployer");
  const stateView = await deployOn(provider, signer, nonceRef, "RobinStateView", [await pm.getAddress()]);
  const reg = await deployOn(provider, signer, nonceRef, "FeeWalletRegistry", [signer.address, signer.address]);
  const lockVault = await deployOn(provider, signer, nonceRef, "LockVault", [await posm.getAddress(), await reg.getAddress()]);
  const curveDeployer = await deployOn(provider, signer, nonceRef, "CurveV4Deployer", [await dep.getAddress()]);
  const feeConfig = await deployOn(provider, signer, nonceRef, "RobinV4FeeConfig", [signer.address, DEFAULTS]);
  const factory = await deployOn(provider, signer, nonceRef, "CurvePadFactoryV4", [
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDeployer.getAddress(), await feeConfig.getAddress(), await reg.getAddress(),
    await lockVault.getAddress(),
  ]);
  const setFactoryTx = await lockVault.setFactory.populateTransaction(await factory.getAddress());
  await (await signer.sendTransaction({ ...setFactoryTx, nonce: nonceRef.n++ })).wait();

  const addrs = {
    deterministicDeployer: await dep.getAddress(),
    stateView: await stateView.getAddress(),
    feeWalletRegistry: await reg.getAddress(),
    lockVault: await lockVault.getAddress(),
    curveDeployer: await curveDeployer.getAddress(),
    feeConfig: await feeConfig.getAddress(),
    factory: await factory.getAddress(),
  };
  for (const [k, v] of Object.entries(addrs)) console.log(`  [${label}] ${k.padEnd(22)} ${v}`);
  return { pm, permit2, posm, dep, stateView, reg, lockVault, curveDeployer, feeConfig, factory };
}

async function main() {
  const rpcA = process.env.CHAIN_A_RPC || "http://127.0.0.1:8610";
  const rpcB = process.env.CHAIN_B_RPC || "http://127.0.0.1:8611";
  const providerA = new ethers.JsonRpcProvider(rpcA);
  const providerB = new ethers.JsonRpcProvider(rpcB);
  const [funderA] = await Promise.all([providerA.getSigner(0)]);
  const [funderB] = await Promise.all([providerB.getSigner(0)]);

  // A FRESH random wallet on each chain, funded by a transfer (which consumes the FUNDER's nonce, not the
  // fresh wallet's — the fresh wallet's own nonce stays exactly 0 going into the bootstrap, same starting
  // condition on both chains, exactly matching how a real deployer key would be funded before its first tx).
  const pk = ethers.Wallet.createRandom().privateKey; // SAME key used as the deployer on BOTH chains
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
  const keys = { deterministicDeployer: "dep", stateView: "stateView", feeWalletRegistry: "reg", lockVault: "lockVault", curveDeployer: "curveDeployer", feeConfig: "feeConfig", factory: "factory" };
  for (const [label, k] of Object.entries(keys)) {
    const a = await SA[k].getAddress();
    const b = await SB[k].getAddress();
    const match = a.toLowerCase() === b.toLowerCase();
    allMatch &&= match;
    console.log(`  ${label.padEnd(22)} ${match ? "MATCH " : "DIVERGED"}  ${a}${match ? "" : "  vs  " + b}`);
  }
  // mock infra addresses are EXPECTED to differ (fresh, independent deploys) — confirms the claim that
  // differing constructor args never break the CREATE-address match above.
  const pmMatch = (await SA.pm.getAddress()).toLowerCase() === (await SB.pm.getAddress()).toLowerCase();
  console.log(`  (mock PoolManager addresses ${pmMatch ? "matched (coincidence, harmless)" : "differ, as expected"} — proves constructor args don't matter for CREATE)`);

  if (!allMatch) {
    console.log("\nFAILED: infra addresses diverged. See scripts/prove-dualchain-address-match.js's claim above.");
    process.exit(1);
  }

  console.log("\n=== Launching the SAME coin on both chains ===");
  const cfg = {
    name: "Dual Chain Demo", symbol: "DUAL", decimals: 18,
    supply: 1_000_000_000n * 10n ** 18n, curveSupply: 730_000_000n * 10n ** 18n, reserveSupply: 270_000_000n * 10n ** 18n,
    tickSpacing: TS, startTickMag: 0, creator: deployerA.address, noPoolForever: false, lpFee: LP_FEE,
  };
  // mined ONCE — same deployer, same factory address (now confirmed matching), same initCodeHash on both
  // chains, so the SAME salt is valid everywhere the stack is mirrored.
  const tokenSalt = await brandedTokenSalt(await SA.dep.getAddress(), await SA.factory.getAddress(), cfg, ethers.id("dualchain-proof"));
  const TokenF = await artifacts.readArtifact("PadToken");
  const predictedToken = predictPadToken(await SA.dep.getAddress(), await SA.factory.getAddress(), cfg, tokenSalt, TokenF.bytecode);
  const HookF = await artifacts.readArtifact("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(
    await SA.dep.getAddress(),
    hookInitCode(HookF.bytecode, await SA.pm.getAddress(), await SA.factory.getAddress(), await SA.reg.getAddress(), predictedToken)
  );
  const curveSalt = ethers.id("dualchain-proof-curve");
  console.log(`  predicted token address: ${predictedToken}`);

  // Explicit gasLimit throughout: hardhat's automatic gas estimation produced a wildly inflated number for
  // this call in testing (~21.9M, tripping the node's 16.7M-per-tx cap outright) when the REAL usage measured
  // under an explicit limit is ~7.3M — a known estimation quirk on CREATE2-heavy multi-step transactions, not
  // a real gas problem. Extracting the launched address from the CurvePadLaunched event rather than
  // `.staticCall` for the same reason (staticCall's own gas auto-fill hit the identical bad estimate).
  const LAUNCH_GAS = 16_000_000;
  const launchTxA = await SA.factory.connect(deployerA).launch.populateTransaction(cfg, tokenSalt, hookSalt, curveSalt);
  const rcA = await (await deployerA.sendTransaction({ ...launchTxA, nonce: await providerA.getTransactionCount(deployerA.address), gasLimit: LAUNCH_GAS })).wait();
  const evA = rcA.logs.map((l) => { try { return SA.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "CurvePadLaunched");
  console.log(`  [A] launched: token=${evA.args.token}  (gas used ${rcA.gasUsed})`);

  const launchTxB = await SB.factory.connect(deployerB).launch.populateTransaction(cfg, tokenSalt, hookSalt, curveSalt);
  const rcB = await (await deployerB.sendTransaction({ ...launchTxB, nonce: await providerB.getTransactionCount(deployerB.address), gasLimit: LAUNCH_GAS })).wait();
  const evB = rcB.logs.map((l) => { try { return SB.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "CurvePadLaunched");
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
  console.log("\nPROVEN: one mined salt, one LaunchConfig, two independent chains, one identical branded token address.");
}

main().catch((e) => { console.error(e); process.exit(1); });
