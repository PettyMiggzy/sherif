const { ethers } = require("hardhat");

const HOOK_FLAGS = 0xccn; // BEFORE_SWAP | AFTER_SWAP | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA
const FLAG_MASK = 0x3fffn;

// Brand suffix: every Robin pad token address ends in `faf0`, so a Robin coin is recognizable (and
// impersonation is visible) straight from its contract address. 16 bits ⇒ ~65k expected tries; measured
// ~2s / ~73k tries per launch in node (see mineTokenSalt). A browser miner should use a WASM keccak.
const CA_SUFFIX = 0xfaf0n;
const CA_SUFFIX_MASK = 0xffffn; // low 16 bits == the last 4 hex characters of the address

/// Mine a CREATE2 salt so the hook deployed by `deployerAddr` lands on an address whose low 14
/// bits equal 0x00CC (the flags the PoolManager reads). Sub-second — ~2^14 expected tries.
function mineHookSalt(deployerAddr, initCode, maxTries = 5_000_000) {
  const initCodeHash = ethers.keccak256(initCode);
  for (let i = 0n; i < BigInt(maxTries); i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, salt, initCodeHash);
    if ((BigInt(addr) & FLAG_MASK) === HOOK_FLAGS) return { salt, addr, initCodeHash };
  }
  throw new Error("hook salt not found within maxTries");
}

/// Mine a CREATE2 salt so the pad TOKEN lands on an address ending in `faf0` (the Robin brand suffix).
///
/// Salts are derived as keccak256(baseSalt, i) rather than the raw counter `mineHookSalt` uses, because the
/// token's init-code hash is a function of (name, symbol, decimals, supply, factory) — two pads sharing all
/// five would otherwise mine the SAME salt and land on the SAME CREATE2 address, where `deployer.deploy`
/// ADOPTS the existing token ([audit L6]) instead of deploying a fresh one. Seeding the search with a
/// per-pad `baseSalt` gives every launch its own region of salt space, so that can't happen.
///
/// Returns the mined salt plus the address it produces, so the caller can feed the SAME predicted token into
/// the hook init-code (the hook's constructor takes the token, so token mining MUST run first).
function mineTokenSalt(deployerAddr, initCode, baseSalt, opts = {}) {
  const { suffix = CA_SUFFIX, maxTries = 20_000_000, accept } = opts;
  const initCodeHash = ethers.keccak256(initCode);
  const want = suffix.toString(16).padStart(4, "0"); // "faf0" — the last 4 hex chars of the address

  // Hash the CREATE2 preimage `0xff ++ deployer ++ salt ++ initCodeHash` in ONE preallocated 85-byte buffer,
  // mutating only the counter bytes per try. Going through ethers.getCreate2Address instead costs a hex
  // encode/decode round-trip per iteration and measured 10-25s for a 16-bit suffix; this measures ~2s.
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(ethers.getBytes(deployerAddr), 1);
  buf.set(ethers.getBytes(baseSalt), 21); // salt occupies bytes [21,53)
  buf.set(ethers.getBytes(initCodeHash), 53);
  const view = new DataView(buf.buffer);

  for (let i = 0; i < maxTries; i++) {
    // Vary only the salt's LAST 8 bytes; the leading 24 bytes stay the per-pad `baseSalt`, so two pads with
    // byte-identical token init-code still search disjoint salt space and can never land on the same address.
    view.setUint32(49, i, false); // bytes [49,53) — the tail of the salt region
    const h = ethers.keccak256(buf);
    if (h.endsWith(want)) {
      const addr = ethers.getAddress("0x" + h.slice(26));
      // `accept` carries any ADDITIONAL address constraint (stock pads need token > stock for currency
      // ordering). Checked inside this loop — and only on a suffix hit, so it costs nothing on the hot
      // path — rather than by re-running whole 65k-try passes and discarding the losers.
      if (accept && !accept(addr)) continue;
      const salt = ethers.hexlify(buf.slice(21, 53));
      return { salt, addr, initCodeHash, tries: i + 1 };
    }
  }
  throw new Error(`token salt for suffix 0x${want} not found within maxTries`);
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

module.exports = { HOOK_FLAGS, FLAG_MASK, CA_SUFFIX, CA_SUFFIX_MASK, mineHookSalt, mineTokenSalt, hookInitCode };
