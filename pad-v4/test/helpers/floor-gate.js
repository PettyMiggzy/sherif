// Shared wiring for the [H-5] floor gate: a REAL, flag-mined RobinFeeHook is now a prerequisite for any commit,
// because `RobinFloorVault.addFloor()` proves continuous below-band price off the hook's swap-witnessed
// `aboveLowerTs` watermark. A hookless pool can never commit (it parks with reason R_ORACLE), which is the
// correct production behaviour — every pad the three factories launch has a hook.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const abi = ethers.AbiCoder.defaultAbiCoder();
// [MERGE] 0x28CC, not 0x00CC — [L-25] added a FACTORY-ONLY beforeInitialize on this branch, and the flags are
// mined into the hook's address, so mining 0x00CC lands on an address the hook's own ctor assert rejects.
const FLAGS = 0x28ccn, MASK = 0x3fffn;

function mineHookSalt(dep, initCodeHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(dep, salt, initCodeHash);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}

/// Deploy a real RobinFeeHook at a mined 0x…CC address for (pm, factorySigner, reg, token).
async function deployHook(pm, factorySigner, reg, token) {
  const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const initCode = ethers.concat([
    HookF.bytecode,
    abi.encode(["address", "address", "address", "address"], [
      await pm.getAddress(), factorySigner.address, await reg.getAddress(), await token.getAddress(),
    ]),
  ]);
  const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
  await dep.deploy(salt, initCode);
  return { hook: HookF.attach(addr), hookAddr: addr, dep };
}

async function registerPool(hook, factorySigner, poolId, token, creator, opts = {}) {
  await hook.connect(factorySigner).registerPool(poolId, {
    currency0: ethers.ZeroAddress, currency1: await token.getAddress(), creator,
    floorRecipient: ethers.ZeroAddress, guardAdapter: ethers.ZeroAddress,
    buyTaxBps: opts.buyTaxBps ?? 100, sellTaxBps: opts.sellTaxBps ?? 100,
    sellFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
    guardWindow: 0, quoteIsStock: false,
  });
}

/// The shipped runbook pair: point the hook's floor carve at the vault, then arm the gate for its band.
async function wireAndArm(hook, platform, poolId, vault) {
  await hook.connect(platform).setFloorRecipient(poolId, await vault.getAddress());
  await hook.connect(platform).armFloorGate(poolId);
}

/// Advance past the vault's warm-up (`armedAt + MIN_BELOW_DURATION`) without touching the band. No swap is
/// needed while the tick is already below the band and nothing moves it — the watermark only advances on a
/// swap whose PRE-swap tick is at/above the band.
async function warmUp(vault, extra = 1) {
  await time.increase(Number(await vault.MIN_BELOW_DURATION()) + extra);
}

module.exports = { mineHookSalt, deployHook, registerPool, wireAndArm, warmUp };
