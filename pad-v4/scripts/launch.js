/*
 * One-command pad launch + full wiring on Robinhood Chain (legacy type-0 txs).
 * Reads the bootstrap addresses from deploy.local.json (produced by scripts/deploy.js), then:
 *   1. mines the hook salt (address low-14-bits == 0x00CC)
 *   2. factory.launch(...)  → deploys token + hook + pool + seed LP (atomic), floorRecipient unset
 *   3. deploys RobinFloorVault for the new pool and wires it via hook.setFloorRecipient (one-shot)
 *   4. creates a DualStaking pool for the token via StakingFactory (5% fee, no lock)
 *   5. points the LockVault token-leg LP fee at the staking reward keeper (setStakingRecipient, one-shot)
 * Appends the launch record to deploy.local.json.
 *
 * Usage (env): PRIVATE_KEY (=platform/deployer), ROBINHOOD_RPC,
 *   NAME, SYMBOL, SUPPLY(1e18 units), LP_TOKENS(1e18), SEED_ETH(eth), STOCK(optional stake-pair),
 *   REWARD_KEEPER(addr that will stream the token LP fee to stakers; defaults to platform)
 *   npx hardhat run scripts/launch.js --network robinhood
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { mineHookSalt, hookInitCode } = require("./mine");

const SQRT_1_1 = 79228162514264337593543950336n; // launch at price 1:1 (tick 0); override via SQRT_PRICE
const FEE = 3000; // static lp fee
const TS = 60; // tick spacing
const FLOOR_BAND_SPACINGS = 20; // floor wall width

async function legacy(c, method, args, value = 0n) {
  const tx = await c[method](...args, { type: 0, value });
  return tx.wait();
}

async function main() {
  const file = path.join(__dirname, "..", "deploy.local.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();
  const platform = d.platformWallet;
  const rewardKeeper = process.env.REWARD_KEEPER || platform;

  const cfg = {
    name: process.env.NAME || "Robin Coin",
    symbol: process.env.SYMBOL || "ROBIN",
    decimals: 18,
    supply: BigInt(process.env.SUPPLY || "1000000") * 10n ** 18n,
    lpTokenAmount: BigInt(process.env.LP_TOKENS || "500000") * 10n ** 18n,
    sqrtPriceX96: BigInt(process.env.SQRT_PRICE || SQRT_1_1.toString()),
    tickSpacing: TS,
    fee: FEE,
    buyTaxBps: Number(process.env.BUY_TAX_BPS || 100),
    sellTaxBps: Number(process.env.SELL_TAX_BPS || 100),
    sellFloorShareBps: Number(process.env.FLOOR_SHARE_BPS || 2000),
    creator: process.env.CREATOR || signer.address,
    floorRecipient: ethers.ZeroAddress, // wired after the floor vault exists
    stakingRecipient: ethers.ZeroAddress, // wired after the staking pool exists
  };
  const seedEth = ethers.parseEther(process.env.SEED_ETH || "1");

  const factory = await ethers.getContractAt("PadFactory", d.padFactory);
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const abi = ethers.AbiCoder.defaultAbiCoder();

  // 1) predict the token CREATE2 address (factory deploys it), then mine the hook salt against the
  //    exact init-code the factory builds — which now includes the token so each hook is unique.
  const tokenSalt = ethers.id(`${cfg.symbol}-${cfg.name}-${d.padFactory}-${process.env.SALT_NONCE || "0"}`);
  const TokenF = await ethers.getContractFactory("PadToken");
  const tokenInit = ethers.concat([
    TokenF.bytecode,
    abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, d.padFactory]),
  ]);
  const predictedToken = ethers.getCreate2Address(d.deterministicDeployer, tokenSalt, ethers.keccak256(tokenInit));
  const initCode = hookInitCode(HookF.bytecode, d.poolManager, d.padFactory, d.feeWalletRegistry, predictedToken);
  const { salt: hookSalt } = mineHookSalt(d.deterministicDeployer, initCode);

  // 2) launch the pad atomically
  console.log(`Launching ${cfg.name} (${cfg.symbol})…`);
  const rc = await legacy(factory, "launch", [cfg, tokenSalt, hookSalt], seedEth);
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "PadLaunched");
  const { token, hook, poolId, lpTokenId } = ev.args;
  console.log(`  token ${token}\n  hook  ${hook}\n  pool  ${poolId}\n  lpNFT ${lpTokenId}`);

  // 3) deploy + wire the floor vault — anchor the band to the INTENDED launch tick (from sqrtPriceX96),
  //    never a live read, so it can't be pushed off before the (non-atomic) vault deploy.
  const FloorF = await ethers.getContractFactory("RobinFloorVault");
  const ratio = Number(cfg.sqrtPriceX96) / 2 ** 96;
  const anchorTick = Math.floor(Math.log(ratio * ratio) / Math.log(1.0001));
  const floor = await FloorF.deploy(
    d.poolManager, d.stateView, platform, ethers.ZeroAddress, token, FEE, TS, hook, anchorTick, FLOOR_BAND_SPACINGS, { type: 0 }
  );
  await floor.waitForDeployment();
  const floorAddr = await floor.getAddress();
  const hookC = HookF.attach(hook);
  await legacy(hookC, "setFloorRecipient", [poolId, floorAddr]); // platform-gated (signer must be platform)
  console.log(`  floorVault ${floorAddr}  (wired)`);

  // 4) staking pool for the token (5% fee, no lock)
  const stakingFactory = await ethers.getContractAt("StakingFactory", d.stakingFactory);
  const src = await legacy(stakingFactory, "createPool", [token, process.env.STOCK || ethers.ZeroAddress, 0, rewardKeeper]);
  const sev = src.logs.map((l) => { try { return stakingFactory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "StakingPoolCreated");
  const stakingPool = sev.args.pool;
  console.log(`  stakingPool ${stakingPool}  (owner accepts via acceptOwnership; keeper ${rewardKeeper} funds token LP fee)`);

  // 5) point the LockVault token-leg LP fee at the reward keeper (it forwards to the pool as a stream)
  const lockVault = await ethers.getContractAt("LockVault", d.lockVault);
  await legacy(lockVault, "setStakingRecipient", [lpTokenId, rewardKeeper]); // platform-gated
  console.log(`  lockVault stakingRecipient -> ${rewardKeeper}`);

  d.launches = d.launches || [];
  d.launches.push({ token, hook, poolId: poolId.toString?.() ?? poolId, lpTokenId: lpTokenId.toString(), floorVault: floorAddr, stakingPool, tokenSalt, symbol: cfg.symbol });
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`\nLaunched + wired. Record appended to ${file}.`);
  console.log(`Next: platform multisig calls acceptOwnership() on ${stakingPool}; list token as a reward + add the keeper as rewarder if not already.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
