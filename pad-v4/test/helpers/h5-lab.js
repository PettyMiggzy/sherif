// Shared lab harness for the independent H-5 reproduction.
// Plain PoolManager, real v4 math, real RobinFloorVault. No mocks of the vault.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const poolIdOf = (k) =>
  ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
const E = (x) => ethers.parseEther(String(x));
const f = (x, d = 4) => Number(ethers.formatEther(x)).toFixed(d);

const FLAGS = 0xccn, MASK = 0x3fffn;
function mineHookSalt(dep, h) {
  for (let i = 0n; ; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(dep, s, h);
    if ((BigInt(a) & MASK) === FLAGS) return { salt: s, addr: a };
  }
}

// ── the lab ────────────────────────────────────────────────────────────────────
// cfg:
//   baseL          liquidity units for the single wide LP position (sets pool depth)
//   lpRange        LP position half-width in ticks (default 60000)
//   carve          bigint wei parked in the floor vault (0 == the auditor's CONTROL)
//   dumpTick       tick the pad has dumped to before the attack starts
//   bandSpacings   floor band width in tickSpacings (shipped launch.js value = 20 → band [60,1260])
//   fee            pool lp fee (shipped 3000)
//   hookTaxBps     0 = plain pool; >0 = deploy the real RobinFeeHook with this buy AND sell tax
async function buildLab(cfg) {
  const TS = 60, FEE = cfg.fee ?? 3000;
  const lpRange = cfg.lpRange ?? 60000;
  const [owner, lp, trader, platform, attacker, creator, factorySigner] = await ethers.getSigners();

  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
  const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
  const tick = await (await ethers.getContractFactory("TickHelper")).deploy();
  const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 32n);
  const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);

  let hookAddr = ZERO, hook = null;
  if (cfg.hookTaxBps || cfg.withHook) {
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address", "address"], [await pm.getAddress(), factorySigner.address, await reg.getAddress(), await tok.getAddress()]),
    ]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr);
    hookAddr = addr;
  }

  const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: hookAddr };
  const poolId = poolIdOf(key);
  await pm.initialize(key, SQRT_1_1); // tick 0 == launch

  if (hook) {
    await hook.connect(factorySigner).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address, floorRecipient: ZERO,
      guardAdapter: ZERO, buyTaxBps: cfg.hookTaxBps ?? 0, sellTaxBps: cfg.hookTaxBps ?? 0, sellFloorShareBps: 2000,
      buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 0, quoteIsStock: false,
    });
    await hook.connect(factorySigner).setBufferRecipient(poolId, owner.address);
  }

  const mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
  const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

  await tok.connect(owner).transfer(lp.address, 10n ** 30n);
  await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
  await ethers.provider.send("hardhat_setBalance", [lp.address, "0x" + (10n ** 26n).toString(16)]);
  await mod.connect(lp).modifyLiquidity(
    key, { tickLower: -lpRange, tickUpper: lpRange, liquidityDelta: cfg.baseL, salt: ethers.ZeroHash }, "0x",
    { value: 10n ** 24n }
  );
  const depthAtLaunch = await ethers.provider.getBalance(await pm.getAddress());

  // The H5* variant vaults are byte-identical copies of EARLIER shipped versions, so they keep the OLD
  // constructor. Only the real vault takes the [R3-H5 P2] episodeBaseWei param.
  const vaultName = cfg.vaultContract ?? "RobinFloorVault";
  const vaultArgs = [
    await pm.getAddress(), await stateView.getAddress(), await reg.getAddress(),
    ZERO, await tok.getAddress(), FEE, TS, hookAddr, 0 /* anchorTick = launch */, cfg.bandSpacings ?? 20,
  ];
  if (vaultName === "RobinFloorVault") vaultArgs.push(cfg.episodeBaseWei ?? 0n);
  const vault = await (await ethers.getContractFactory(vaultName)).deploy(...vaultArgs);
  // shipped wiring: the sell-tax floor carve flows to the vault (attacker-favourable — their own sell-back
  // partially re-funds the carve they are draining)
  if (hook) {
    await hook.connect(platform).setFloorRecipient(poolId, await vault.getAddress());
    // [R3-H5 P1] Arm the swap-witnessed gate. Only the real vault has it; the H5* variants predate it.
    if (vaultName === "RobinFloorVault" && cfg.armGate !== false) await vault.connect(platform).armGate();
  }

  // helpers -------------------------------------------------------------------
  const sqrtAt = (t) => tick.sqrt(t);
  const nowTick = async () => Number((await stateView.getSlot0(poolId))[1]);

  await tok.connect(owner).transfer(trader.address, 10n ** 30n);
  await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
  await ethers.provider.send("hardhat_setBalance", [trader.address, "0x" + (10n ** 26n).toString(16)]);

  // DUMP the pad: sell token until the tick reaches dumpTick (token far cheaper than launch)
  await sw.connect(trader).swap(
    key, { zeroForOne: false, amountSpecified: -(10n ** 29n), sqrtPriceLimitX96: await sqrtAt(cfg.dumpTick) },
    { takeClaims: false, settleUsingBurn: false }, "0x"
  );
  const depthPreAttack = await ethers.provider.getBalance(await pm.getAddress());

  // park the carve — spot is above the band, so this is the honest, correct outcome
  if (cfg.carve > 0n) {
    await owner.sendTransaction({ to: await vault.getAddress(), value: cfg.carve });
    await vault.addFloor();
  } else {
    await vault.addFloor(); // no-op (balance 0) — the control still runs the same call
  }

  await tok.connect(attacker).approve(await sw.getAddress(), ethers.MaxUint256);
  await ethers.provider.send("hardhat_setBalance", [attacker.address, "0x" + (10n ** 26n).toString(16)]);

  return {
    pm, stateView, tok, vault, mod, sw, key, poolId, tick, sqrtAt, nowTick,
    owner, lp, trader, platform, attacker, hook,
    depthAtLaunch, depthPreAttack,
    bandLower: Number(await vault.floorTickLower()), bandUpper: Number(await vault.floorTickUpper()),
  };
}

// gas-aware attacker ledger
function ledger(addr) {
  return { addr, gas: 0n, async track(txp) { const rc = await (await txp).wait(); this.gas += rc.gasUsed * rc.gasPrice; return rc; } };
}

function unpack(d) {
  const u = BigInt.asUintN(256, d);
  return [BigInt.asIntN(128, u >> 128n), BigInt.asIntN(128, u & ((1n << 128n) - 1n))];
}

// Size the ETH push so the pool lands exactly at `targetTick` — the attacker's minimum-notional push.
// On a hooked pad the buy tax is charged on the REQUESTED input (documented [audit LOW] partial-fill
// behaviour), so a price-limited "shove with a huge amountSpecified" would burn tax on the whole request.
// A real attacker sizes the input; this reproduces that.
async function sizePush(L, targetTick, taxBps) {
  const { sw, key, attacker, sqrtAt } = L;
  const req = 10n ** 24n;
  const d = await sw.connect(attacker).swap.staticCall(
    key, { zeroForOne: true, amountSpecified: -req, sqrtPriceLimitX96: await sqrtAt(targetTick) },
    { takeClaims: false, settleUsingBurn: false }, "0x", { value: req }
  );
  const [a0] = unpack(d);
  const poolInput = -a0 - (req * BigInt(taxBps)) / 10000n;
  if (taxBps === 0) return poolInput;
  return (poolInput * 10000n) / BigInt(10000 - taxBps) + 10n ** 12n; // +1e-6 ETH so rounding never lands on tick 60
}

module.exports = { ZERO, SQRT_1_1, MIN_SQRT_LIMIT, MAX_SQRT_LIMIT, poolIdOf, E, f, buildLab, ledger, unpack, sizePush };
