/*
 * FORK DEMO — deploys the pad-v4 stack against a FORKED Robinhood Chain (real PoolManager, real
 * PositionManager, real Permit2 — no mocks needed, since forking makes the real deployed periphery
 * reachable). Run this against a node started with:
 *
 *   FORK_RPC=https://rpc.mainnet.chain.robinhood.com npx hardhat node --hostname 0.0.0.0 --port 8545
 *
 * then:
 *
 *   npx hardhat run scripts/deploy-fork-demo.js --network localhost
 *
 * The fork carries the REAL chain's state (every real coin, real pool, real balance) up to the block
 * it forked at, PLUS Hardhat's cheat-codes (hardhat_setBalance, hardhat_impersonateAccount) work on
 * it — so any tester wallet can be topped up with as much fake ETH as needed, instantly, with no
 * faucet. This is a local simulation of the real chain, not the real chain — nothing broadcasts back
 * to Robinhood Chain itself; it exists only inside whatever machine runs this Hardhat node.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { mineHookSalt, hookInitCode } = require("./mine");
const { brandedTokenSalt, predictPadToken } = require("../test/helpers/brand");

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;

// Real Uniswap v4 infra already deployed on Robinhood Chain (same addresses the fork tests use).
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const START = 201600, WIDTH = 23000, TS = 100, FEE = 10000, MINGRAD = 22800;
const DEFAULTS = {
  buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 0, buyBufferShareBps: 2000,
  referralShareBps: 2500, platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 1500,
  lpFee: FEE, startTickMag: START, curveWidth: WIDTH, minGradWidth: MINGRAD,
  minFdvWei: ethers.parseEther("0.05"), maxFdvWei: ethers.parseEther("100"),
};

async function deploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(28)} ${await c.getAddress()}`);
  return c;
}

async function launchDemoPad(S, { name, symbol, supplyM, curveShareBps, tag, creator }) {
  const supply = BigInt(supplyM) * 10n ** 18n;
  const curveSupply = (supply * BigInt(curveShareBps)) / 10000n;
  const reserveSupply = supply - curveSupply;
  const cfg = {
    name, symbol, decimals: 18, supply, curveSupply, reserveSupply,
    tickSpacing: TS, startTickMag: 0, creator: creator.address, noPoolForever: false, lpFee: 10000,
  };
  const tokenSalt = await brandedTokenSalt(await S.dep.getAddress(), await S.factory.getAddress(), cfg, ethers.id(tag));
  const TokenF = await ethers.getContractFactory("PadToken");
  const predictedToken = predictPadToken(await S.dep.getAddress(), await S.factory.getAddress(), cfg, tokenSalt, TokenF.bytecode);
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(
    await S.dep.getAddress(),
    hookInitCode(HookF.bytecode, POOL_MANAGER, await S.factory.getAddress(), await S.reg.getAddress(), predictedToken)
  );
  const curveSalt = ethers.id(tag + "-curve");

  // Idempotency guard: if a PRIOR attempt's transaction actually landed but the client never saw the
  // response (the flaky-fork failure mode this script retries around), this exact cfg+tokenSalt would
  // already be launched — poolOf(predictedToken) is nonzero. Recover its real data from the emitted
  // event instead of resubmitting (which would revert AlreadyLaunched).
  const existingPoolId = await S.factory.poolOf(predictedToken);
  if (existingPoolId !== ethers.ZeroHash) {
    const filter = S.factory.filters.CurvePadLaunched(null, predictedToken);
    const [log] = await S.factory.queryFilter(filter);
    const { token, hook, curve: curveAddr, poolId } = log.args;
    console.log(`  ${symbol.padEnd(6)} already launched (recovered from a prior attempt) token=${token} curve=${curveAddr}`);
    return { token, hook, curveAddr, poolId, cfg };
  }

  // A staticCall pre-check here (as this script originally did) doubles the work of a call that's
  // already the slow part against a forked real PoolManager (lazy per-slot state fetch over the real
  // remote RPC) — read the real result off the mined tx's logs instead of simulating it twice.
  const rc = await (await S.factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  const parsed = rc.logs.map((l) => { try { return S.factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "CurvePadLaunched");
  const { token, hook, curve: curveAddr, poolId } = parsed.args;
  console.log(`  launched ${symbol.padEnd(6)} token=${token} curve=${curveAddr}`);
  return { token, hook, curveAddr, poolId, cfg };
}

async function simulateTrades(S, pad, buyers) {
  const key = { currency0: ZERO, currency1: pad.token, fee: FEE, tickSpacing: TS, hooks: pad.hook };
  for (const { signer, ethIn } of buyers) {
    await S.sw.connect(signer).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(String(ethIn)), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(String(ethIn)) }
    );
  }
}

// Interacting with the REAL PoolManager over a fork has been observed to intermittently die mid-request
// (SocketError "other side closed" / HeadersTimeoutError) — the forked node lazily fetches any storage
// slot it hasn't cached yet from the real remote RPC, and a call that touches a lot of the real
// PoolManager's state (launching a pad does) can apparently trip something in that path. Nothing ever
// reaches the Hardhat node's own log when it happens (confirmed on two separate machines), and a plain
// retry immediately succeeds — so retry each pad's launch+trade step independently instead of failing
// the whole run over one flaky call.
async function withRetry(fn, label, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts) throw e;
      console.log(`  ${label}: attempt ${i} failed (${e.code || e.message}) — retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== 4663n) {
    throw new Error(`expected a fork of Robinhood Chain (chainId 4663), got ${chainId} — start the node with FORK_RPC set`);
  }
  const signers = await ethers.getSigners();
  const [deployer, platform, creatorA, creatorB, creatorC, buyer1, buyer2, buyer3] = signers;

  // Cheat-codes only exist on a Hardhat node, not the real chain — give every demo signer plenty of ETH
  // regardless of what the forked account actually held, so nobody needs a faucet.
  for (const s of signers) {
    await ethers.provider.send("hardhat_setBalance", [s.address, "0x21E19E0C9BAB2400000"]); // 100,000 ETH
  }
  console.log(`Deploying FORK DEMO stack (real chainId ${chainId}) as ${deployer.address}\n`);

  const stateView = await deploy("RobinStateView", [POOL_MANAGER]);
  const dep = await deploy("DeterministicDeployer");
  const reg = await deploy("FeeWalletRegistry", [platform.address, deployer.address]);
  const lockVault = await deploy("LockVault", [POSITION_MANAGER, await reg.getAddress()]);
  const curveDep = await deploy("CurveV4Deployer", [await dep.getAddress()]);
  const feeCfg = await deploy("RobinV4FeeConfig", [deployer.address, DEFAULTS]);
  const factory = await deploy("CurvePadFactoryV4", [
    POOL_MANAGER, POSITION_MANAGER, PERMIT2, await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress(),
  ]);
  await (await lockVault.setFactory(await factory.getAddress())).wait();
  const sw = await deploy("PoolSwapTest", [POOL_MANAGER]);
  const arrowLauncher = await deploy("ArrowLauncher", [await factory.getAddress(), await reg.getAddress(), ethers.parseEther("0.08")]);
  const burnTracker = await deploy("RobinBurnTracker");

  console.log("\nLaunching demo pads against the REAL PoolManager...");
  const S = { dep, reg, factory, sw };

  const padA = await withRetry(() => launchDemoPad(S, { name: "Robin Demo Alpha", symbol: "RALPHA", supplyM: 1_000_000_000, curveShareBps: 7300, tag: "fork-demo-alpha", creator: creatorA }), "RALPHA launch");
  await withRetry(() => simulateTrades(S, padA, [{ signer: buyer1, ethIn: 0.8 }, { signer: buyer2, ethIn: 1.5 }]), "RALPHA trades");

  const padB = await withRetry(() => launchDemoPad(S, { name: "Robin Demo Beta", symbol: "RBETA", supplyM: 500_000_000, curveShareBps: 7300, tag: "fork-demo-beta", creator: creatorB }), "RBETA launch");
  await withRetry(() => simulateTrades(S, padB, [{ signer: buyer2, ethIn: 2.0 }]), "RBETA trades");

  const padC = await withRetry(() => launchDemoPad(S, { name: "Robin Demo Gamma", symbol: "RGAMMA", supplyM: 2_000_000_000, curveShareBps: 7300, tag: "fork-demo-gamma", creator: creatorC }), "RGAMMA launch");
  await withRetry(() => simulateTrades(S, padC, [{ signer: buyer3, ethIn: 3.2 }]), "RGAMMA trades");

  const out = {
    chainId: 4663,
    forked: true,
    rpcUrl: "http://127.0.0.1:8545",
    deployedAt: new Date().toISOString(),
    accounts: {
      deployer: deployer.address, platform: platform.address,
      creatorA: creatorA.address, creatorB: creatorB.address, creatorC: creatorC.address,
      buyer1: buyer1.address, buyer2: buyer2.address, buyer3: buyer3.address,
    },
    contracts: {
      poolManager: POOL_MANAGER,
      stateView: await stateView.getAddress(),
      deterministicDeployer: await dep.getAddress(),
      feeWalletRegistry: await reg.getAddress(),
      permit2: PERMIT2,
      positionManager: POSITION_MANAGER,
      lockVault: await lockVault.getAddress(),
      curveDeployer: await curveDep.getAddress(),
      feeConfig: await feeCfg.getAddress(),
      curveFactory: await factory.getAddress(),
      poolSwapTest: await sw.getAddress(),
      arrowLauncher: await arrowLauncher.getAddress(),
      burnTracker: await burnTracker.getAddress(),
    },
    pads: [padA, padB, padC].map((p) => ({
      token: p.token, hook: p.hook, curve: p.curveAddr, poolId: p.poolId,
      name: p.cfg.name, symbol: p.cfg.symbol,
    })),
  };
  const file = path.join(__dirname, "..", "..", "pad", "js", "deploy.local.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
  console.log("\nEvery signer above (and any address you add) can be topped up with fake ETH any time via:");
  console.log('  hardhat_setBalance("<address>", "0x<hex wei>")');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
