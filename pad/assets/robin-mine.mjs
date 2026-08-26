// GENERATED COPY — do not edit. Source: launchpad/mine/robin-mine.mjs (node scripts/sync-miner.mjs).
/*
 * robin-mine — the ONE `1ab5` salt miner, shared by the hardhat tests, the site, the Telegram bot and the SDK.
 *
 * Every Robin coin address must end in `1ab5` (contracts/PadBrand.sol enforces it on every launch path), so a
 * launch cannot happen without a salt mined off-chain. This file is that miner, and it is deliberately the only
 * copy: four independent transcriptions of a three-keccak CREATE2 chain is four chances to be subtly wrong, and
 * a wrong one fails as `BadTokenSuffix` at launch time with nothing pointing back at the arithmetic.
 *
 * THE CHAIN (all three steps, in order):
 *   inner = keccak256(pack(creator,  candidate))   CurvePadFactory binds the CALLER, so a mined address
 *                                                  belongs to the wallet that mined it and a leaked salt is
 *                                                  worthless to anyone else.
 *   outer = keccak256(pack(factory,  inner))       LaunchTokenDeployer binds ITS caller (the factory).
 *   addr  = CREATE2(tokenDeployer, outer, initCodeHash)
 *
 * `initCodeHash` is NOT computed here. It comes from PadAddressLens.tokenInitCodeHash() on-chain, fetched once
 * before the loop: shipping LaunchToken's bytecode into a browser bundle would let the client drift from the
 * deployer that is actually live, and the only symptom would be every launch reverting.
 *
 * An ES module: the site (`<script type="module">`), the Telegram bot and the SDK import it directly; the
 * hardhat tests, which are CommonJS, reach it with `await import()`. It takes `ethers` as an ARGUMENT rather
 * than importing it, so it runs against whichever copy the host already has — the site bundles its own.
 */
export const SUFFIX = "1ab5";

/// The address `factory.launchWithSalt(p, candidate)` would deploy `creator`'s coin to.
export function predict(ethers, { tokenDeployer, factory, creator, initCodeHash }, candidate) {
  const inner = ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [creator, candidate]));
  const outer = ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [factory, inner]));
  return ethers.getCreate2Address(tokenDeployer, outer, initCodeHash);
}

/// Build the three preallocated buffers the mining loop hashes, with every constant byte already in place.
///
/// This exists because the readable version above is ~1,000 tries/sec — measured 288,750 tries in 268
/// SECONDS on a full 16-bit mine, which is not a thing a browser tab or a Telegram bot can do. Almost all of
/// that is hex: `solidityPacked` and `getCreate2Address` each encode and decode strings, so a three-keccak
/// chain pays for six string conversions per try. Hashing preallocated `Uint8Array`s and mutating only the
/// bytes that change cuts it to two.
function _rig(ethers, { tokenDeployer, factory, creator, initCodeHash }) {
  const inner = new Uint8Array(52); // creator(20) ++ candidate(32)
  inner.set(ethers.getBytes(creator), 0);
  const outer = new Uint8Array(52); // factory(20) ++ inner(32)
  outer.set(ethers.getBytes(factory), 0);
  const create2 = new Uint8Array(85); // 0xff ++ deployer(20) ++ outer(32) ++ initCodeHash(32)
  create2[0] = 0xff;
  create2.set(ethers.getBytes(tokenDeployer), 1);
  create2.set(ethers.getBytes(initCodeHash), 53);
  return { inner, outer, create2 };
}

/// Hash one candidate through the whole chain and return the CREATE2 hash as hex.
///
/// The last 20 bytes of that hash ARE the address, so its last four hex characters are the address's last
/// four — the suffix can be tested on the hash directly and the address only built for the one candidate
/// that wins.
function _step(ethers, rig, candidateBytes) {
  rig.inner.set(candidateBytes, 20);
  rig.outer.set(ethers.getBytes(ethers.keccak256(rig.inner)), 20);
  rig.create2.set(ethers.getBytes(ethers.keccak256(rig.outer)), 21);
  return ethers.keccak256(rig.create2);
}

/// Mine a salt whose coin address ends in `1ab5`.
///
/// Candidates are `baseSalt` with its last 8 bytes replaced by a counter, so two creators who both start at
/// zero search DIFFERENT regions of salt space. Sharing a region matters: `CREATE2` at an occupied address
/// does not revert here, it ADOPTS the deployment already sitting there.
///
/// @param opts.onProgress called every `opts.progressEvery` tries with the try count, so a browser can paint
///        a bar instead of appearing to freeze.
/// @param opts.deadlineMs abort and throw after this many ms rather than hanging a UI forever.
export function mineSalt(ethers, ctx, baseSalt, opts = {}) {
  const {
    suffix = SUFFIX,
    maxTries = 20_000_000,
    onProgress = null,
    progressEvery = 8192,
    deadlineMs = 0,
    now = () => Date.now(),
  } = opts;
  const want = suffix.toLowerCase();
  const started = now();
  const rig = _rig(ethers, ctx);
  const cand = ethers.getBytes(baseSalt).slice();
  const candView = new DataView(cand.buffer, cand.byteOffset, cand.byteLength);

  for (let i = 0; i < maxTries; i++) {
    candView.setUint32(28, i, false); // vary bytes [28,32); the leading 28 stay the per-creator seed
    const h = _step(ethers, rig, cand);
    if (h.endsWith(want)) {
      const salt = ethers.hexlify(cand);
      const addr = ethers.getAddress("0x" + h.slice(26));
      // The fast path and the readable `predict` must agree, or a launch reverts BadTokenSuffix with
      // nothing pointing at the arithmetic. Checked once, on the winner, so it costs nothing.
      const check = predict(ethers, ctx, salt);
      if (check !== addr) throw new Error(`robin-mine: fast path disagrees with predict (${addr} vs ${check})`);
      return { salt, addr, tries: i + 1 };
    }
    if (onProgress && (i + 1) % progressEvery === 0) {
      onProgress(i + 1);
      if (deadlineMs && now() - started > deadlineMs) {
        throw new Error(`robin-mine: no ${want} salt after ${i + 1} tries (${deadlineMs}ms deadline)`);
      }
    }
  }
  throw new Error(`robin-mine: no ${want} salt within ${maxTries} tries`);
}

/// The async form: yields to the event loop between chunks so a browser tab stays responsive while mining.
/// Same arithmetic as `mineSalt` — it calls straight into it a chunk at a time rather than re-deriving it.
export async function mineSaltAsync(ethers, ctx, baseSalt, opts = {}) {
  const { chunk = 4096, maxTries = 20_000_000, onProgress = null, suffix = SUFFIX } = opts;
  const want = suffix.toLowerCase();
  const rig = _rig(ethers, ctx);
  const cand = ethers.getBytes(baseSalt).slice();
  const candView = new DataView(cand.buffer, cand.byteOffset, cand.byteLength);

  for (let i = 0; i < maxTries; i++) {
    candView.setUint32(28, i, false);
    const h = _step(ethers, rig, cand);
    if (h.endsWith(want)) {
      const salt = ethers.hexlify(cand);
      return { salt, addr: ethers.getAddress("0x" + h.slice(26)), tries: i + 1 };
    }
    if ((i + 1) % chunk === 0) {
      if (onProgress) onProgress(i + 1);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  throw new Error(`robin-mine: no ${want} salt within ${maxTries} tries`);
}

export function isBranded(addr, suffix = SUFFIX) {
  return typeof addr === "string" && addr.toLowerCase().endsWith(suffix.toLowerCase());
}
