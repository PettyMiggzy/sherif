const { ethers } = require("hardhat");

const HOOK_FLAGS = 0xccn; // BEFORE_SWAP | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
const FLAG_MASK = 0x3fffn;

/// Mine a CREATE2 salt so the hook deployed by `deployerAddr` lands on an address whose low 14
/// bits equal 0x00C4 (the flags the PoolManager reads). Sub-second — ~2^14 expected tries.
function mineHookSalt(deployerAddr, initCode, maxTries = 5_000_000) {
  const initCodeHash = ethers.keccak256(initCode);
  for (let i = 0n; i < BigInt(maxTries); i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, salt, initCodeHash);
    if ((BigInt(addr) & FLAG_MASK) === HOOK_FLAGS) return { salt, addr, initCodeHash };
  }
  throw new Error("hook salt not found within maxTries");
}

/// Build the exact hook init-code the PadFactory builds on-chain. `padToken` is included so each pad's
/// hook address is unique (no second-launch CREATE2 collision).
function hookInitCode(hookBytecode, poolManager, factory, feeRegistry, padToken) {
  return ethers.concat([
    hookBytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address"],
      [poolManager, factory, feeRegistry, padToken]
    ),
  ]);
}

module.exports = { HOOK_FLAGS, FLAG_MASK, mineHookSalt, hookInitCode };
