/*
 * One-command pad launch + full wiring on Robinhood Chain (legacy type-0 txs).
 * Reads the bootstrap addresses from deploy.local.json (produced by scripts/deploy.js), then:
 *   1. mines the hook salt (address low-14-bits == 0x00CC)
 *   2. factory.launch(...)  → deploys token + hook + pool + seed LP (atomic), floorRecipient unset
 *   3. deploys RobinFloorVault, wires it via hook.setFloorRecipient, and ARMS its below-band gate (one-shot each)
 *   4. creates a DualStaking pool for the token via StakingFactory (claim fee = factory default, shipped 0; no lock)
 *  4b. deploys the per-pad RobinTokenTreasury (70% staking / 30% creator-burn) — every token-side LP fee sinks here
 *   5. points the LockVault token-leg LP fee at the treasury (setStakingRecipient, one-shot)
 *  5b. points the floor vault's token-leg LP fee at the treasury (setTokenSink, one-shot) — platform stays ETH-only
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
const { mineHookSalt, mineTokenSalt, hookInitCode } = require("./mine");

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

  // 1) MINE the token CREATE2 address so it ends in the Robin brand suffix `1ab5`, then mine the hook salt
  //    against the exact init-code the factory builds — which includes the token, so token mining MUST run
  //    first and each hook stays unique. Both mines are local keccak loops (~65k / ~16k tries), sub-second.
  const baseSalt = ethers.id(`${cfg.symbol}-${cfg.name}-${d.padFactory}-${process.env.SALT_NONCE || "0"}`);
  const TokenF = await ethers.getContractFactory("PadToken");
  const tokenInit = ethers.concat([
    TokenF.bytecode,
    abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, d.padFactory]),
  ]);
  const { salt: tokenSalt, addr: predictedToken, tries } = mineTokenSalt(d.deterministicDeployer, tokenInit, baseSalt);
  console.log(`  mined token CA ${predictedToken} (ends …${predictedToken.slice(-4)}, ${tries} tries)`);
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
    // [L-11] pass the timelocked registry, not a raw platform address, so a wallet rotation reaches the floor vault
    d.poolManager, d.stateView, d.feeWalletRegistry, ethers.ZeroAddress, token, FEE, TS, hook, anchorTick,
    FLOOR_BAND_SPACINGS,
    // [R3-H5 P2] episodeBaseWei — the per-episode base allowance, taken from the LAUNCH CONFIG and never from a
    // chain read (a live-liquidity read is inflatable by a JIT straddle across the non-atomic launch->deploy gap).
    //
    // [R3-EXT-2] SHIPS AT 0 — THE ONLY VALUE THAT IS NOT A LIVE DRAIN. The previous value here (seedEth) was
    // wrong and is withdrawn. P1 does NOT close H-5 on its own: it proves 195 minutes of continuous below-band
    // price, which by T1 (holding is free per unit time) a sustained hold buys for one round-trip fee, so the
    // gate opens identically for a held price and a genuine crash (measured: first commit at minute 210 at EVERY
    // nonzero base). P2's allowance is therefore the only real bound, and it binds against liveness — at
    // base ~= the carve the armed gate is drained for +8.34 ETH (74%), at base 0 the attacker gets nothing.
    // 0 is safe. It is NOT fully functional: only ETH arriving DURING a below-band episode deploys, so carve
    // banked during a crash stays parked. That is a product limitation to disclose, not a closure — see
    // AUDIT-ROUND-3-EXTERNAL-ADDENDUM-2.md. Do not raise this without re-running H5 case 7.
    0n,
    { type: 0 }
  );
  await floor.waitForDeployment();
  const floorAddr = await floor.getAddress();
  const hookC = HookF.attach(hook);
  await legacy(hookC, "setFloorRecipient", [poolId, floorAddr]); // platform-gated (signer must be platform)
  // [R3-H5 P1] Arm the swap-witnessed below-band gate. MANDATORY: until this lands the hook does not stamp the
  // watermark, the vault reads the gate as unarmed, and the carve PARKS forever (safe, but never deployed).
  await legacy(floor, "armGate", []);
  console.log(`  floorVault ${floorAddr}  (wired + gate armed)`);

  // 4) staking pool for the token (claim fee = the factory's immutable default — shipped 0 per deploy.js [F1]; no lock)
  const stakingFactory = await ethers.getContractAt("StakingFactory", d.stakingFactory);
  const src = await legacy(stakingFactory, "createPool", [token, process.env.STOCK || ethers.ZeroAddress, 0, rewardKeeper]);
  const sev = src.logs.map((l) => { try { return stakingFactory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "StakingPoolCreated");
  const stakingPool = sev.args.pool;
  console.log(`  stakingPool ${stakingPool}  (owner accepts via acceptOwnership; keeper ${rewardKeeper} funds token LP fee)`);

  // [R3-N1] NO curve wiring here: this script drives the PadFactory (seed-LP) path — PadLaunched carries no
  // curve address, and these pads have no curve, no reservoir, and no graduation. Curve pads are launched by
  // the CURVE runbook (deploy-curve.js → check-wiring.js), which wires curve.setStaking(pool) BEFORE graduate()
  // so the reservoir dump is 100% staking (setStaking requires a pool and rejects the treasury's splitter shape).

  // 4b) [fee-model] deploy the per-pad TOKEN treasury — the single sink every token-side LP fee terminates at. On
  //     distribute() it splits 70% → the staking pool / 30% retained as the public burn reserve; the creator (only)
  //     burns the retained 30% when they choose (they pay the gas). The platform never holds a pad token.
  const TreasuryF = await ethers.getContractFactory("RobinTokenTreasury");
  const treasury = await TreasuryF.deploy(token, stakingPool, cfg.creator, { type: 0 });
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`  tokenTreasury ${treasuryAddr}  (70% staking / 30% burn; creator ${cfg.creator} burns)`);

  // 5) point the LockVault token-leg (sell-side) LP fee at the treasury (it splits + retains the burn share)
  const lockVault = await ethers.getContractAt("LockVault", d.lockVault);
  await legacy(lockVault, "setStakingRecipient", [lpTokenId, treasuryAddr]); // platform-gated
  console.log(`  lockVault stakingRecipient -> treasury`);

  // 5b) [fee-model] point the floor vault's TOKEN-side LP fee at the same treasury. The floor's token leg parks
  //     in-vault until this one-shot sink is wired, then sweepTokenFees() forwards it to the treasury.
  await legacy(floor, "setTokenSink", [treasuryAddr]); // platform-gated, one-shot
  console.log(`  floorVault tokenSink -> treasury`);

  d.launches = d.launches || [];
  d.launches.push({ token, hook, poolId: poolId.toString?.() ?? poolId, lpTokenId: lpTokenId.toString(), floorVault: floorAddr, stakingPool, tokenTreasury: treasuryAddr, tokenSalt, symbol: cfg.symbol });
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`\nLaunched + wired. Record appended to ${file}.`);
  console.log(`Next: platform multisig calls acceptOwnership() on ${stakingPool}; list token as a reward + add the keeper as rewarder.`);
  console.log(`      Keeper loop: claim token fees to the treasury, call treasury.distribute() (70% → pool), then pool.fundTokenPushed to book rewards.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
