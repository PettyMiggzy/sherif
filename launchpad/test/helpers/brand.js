const { ethers } = require("hardhat");
// robin-mine is an ES module (the site and the bot import it directly); these tests are CommonJS, so it is
// loaded once, lazily, rather than duplicated in a second CJS copy that could drift from it.
let _mine = null;
const robinMine = async () => (_mine ||= await import("../../mine/robin-mine.mjs"));

/*
 * [BRAND] Every coin address must end in `1ab5` (contracts/PadBrand.sol), so `launch(p)` and
 * `launchWithSupply(p, s, m)` now revert `SaltRequired` and every launch must carry a mined salt. That is one
 * line of contract change and fifty-five call sites across nineteen test files.
 *
 * Rewriting all fifty-five was the obvious move and the wrong one: these files are the audit evidence for the
 * curve, the bond, graduation and the router, and touching every launch in them to chase a salt puts fifty-five
 * chances to change a test's meaning in the path of a change that has nothing to do with what they assert.
 *
 * So the call sites stay exactly as they are, and `brandedFactory()` wraps the factory instead. It intercepts
 * three members and nothing else:
 *   .launch(p, ov)                     -> mine, then launchWithSalt(p, salt, ov)
 *   .launchWithSupply(p, s, m, ov)     -> mine, then launchWithSupplyAndSalt(p, s, m, salt, ov)
 *   .connect(signer)                   -> re-wrap, so `factory.connect(dev).launch(...)` still mines, and mines
 *                                        for DEV — the factory folds msg.sender into the salt, so the caller
 *                                        is part of the address and mining for the wrong signer finds a salt
 *                                        that reverts.
 * Everything else passes straight through to the real contract.
 *
 * Mining is memoized per (deployer, factory, creator, initCodeHash, baseSalt) — ~2.6s a mine, and a suite that
 * launches the same coin shape repeatedly should pay for it once.
 */
const _cache = new Map();

const ZERO_GUARD = {
  deadSecs: 0, phase1Secs: 0, antiSnipeSecs: 0,
  maxTxBps1: 0, maxWalletBps1: 0, maxTxBps2: 0, maxWalletBps2: 0, cooldownSecs: 0,
};

/// The init-code hash `LaunchTokenDeployer` builds — the same value `PadAddressLens.tokenInitCodeHash` serves
/// on-chain (test/brand-1ab5.test.js pins the two against each other, so this is not a second source of truth).
async function tokenInitCodeHash(name, symbol, supply, factoryAddr) {
  const art = await ethers.getContractFactory("LaunchToken");
  return ethers.keccak256(
    ethers.concat([art.bytecode, art.interface.encodeDeploy([name, symbol, supply, factoryAddr, ZERO_GUARD])])
  );
}

/// Mine the salt that lands `creator`'s coin on a `1ab5` address for this exact launch.
async function brandedSalt(factory, creator, p, supply) {
  const factoryAddr = await factory.getAddress();
  const tokenDeployer = await factory.tokenDeployer();
  const total = supply && supply !== 0n ? BigInt(supply) : await factory.TOTAL_SUPPLY();
  const initCodeHash = await tokenInitCodeHash(p.name, p.symbol, total, factoryAddr);
  const ctx = { tokenDeployer, factory: factoryAddr, creator, initCodeHash };
  const key = `${tokenDeployer}|${factoryAddr}|${creator}|${initCodeHash}`;
  if (_cache.has(key)) return _cache.get(key);
  const { salt } = (await robinMine()).mineSalt(ethers, ctx, ethers.id(`${p.symbol}-${p.name}-${creator}`));
  _cache.set(key, salt);
  return salt;
}

/// Mine a salt AND get the address it lands on, for tests that need to know the coin's address before it
/// exists (the pool-squat suites pre-create a Uniswap pool at it).
///
/// This returns the address from the shared miner rather than from a locally transcribed CREATE2 chain. Three
/// of those transcriptions used to live in the pool-squat files; each was a separate chance to be wrong in a
/// way that only shows up as a launch reverting somewhere else entirely.
async function mineFor(factory, creator, p, supply, seed) {
  const factoryAddr = await factory.getAddress();
  const tokenDeployer = await factory.tokenDeployer();
  const total = supply && supply !== 0n ? BigInt(supply) : await factory.TOTAL_SUPPLY();
  const ctx = {
    tokenDeployer,
    factory: factoryAddr,
    creator,
    initCodeHash: await tokenInitCodeHash(p.name, p.symbol, total, factoryAddr),
  };
  const key = `${tokenDeployer}|${factoryAddr}|${creator}|${ctx.initCodeHash}|${seed}`;
  if (_cache.has(key)) return _cache.get(key);
  const { salt, addr } = (await robinMine()).mineSalt(ethers, ctx, ethers.id(seed));
  const out = { salt, addr };
  _cache.set(key, out);
  return out;
}

/// `factory`, with the two salt-less entrypoints transparently routed through the salted ones.
function brandedFactory(factory, signer) {
  const target = signer ? factory.connect(signer) : factory;
  // `runner` is the signer the call will go out as, and therefore the msg.sender the salt binds to. Reading it
  // off the contract rather than tracking it separately means a `.connect()` we did not intercept still mines
  // for the right wallet instead of silently mining for the wrong one.
  const creatorOf = async () => (target.runner && target.runner.address) || (await ethers.getSigners())[0].address;

  const wrapped = {
    async launch(p, ov = {}) {
      return target.launchWithSalt(p, await brandedSalt(target, await creatorOf(), p, 0n), ov);
    },
    async launchWithSupply(p, supply, mag, ov = {}) {
      return target.launchWithSupplyAndSalt(p, supply, mag, await brandedSalt(target, await creatorOf(), p, supply), ov);
    },
  };
  // `.staticCall` is used by tests that want the returned addresses without spending the launch; it hangs off
  // the function object on a real ethers contract, so it has to hang off ours too.
  wrapped.launch.staticCall = async (p, ov = {}) =>
    target.launchWithSalt.staticCall(p, await brandedSalt(target, await creatorOf(), p, 0n), ov);
  wrapped.launchWithSupply.staticCall = async (p, supply, mag, ov = {}) =>
    target.launchWithSupplyAndSalt.staticCall(p, supply, mag, await brandedSalt(target, await creatorOf(), p, supply), ov);

  return new Proxy(target, {
    get(t, k, r) {
      if (k === "connect") return (s) => brandedFactory(t, s);
      if (k === "launch" || k === "launchWithSupply") return wrapped[k];
      const v = Reflect.get(t, k, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

module.exports = { brandedFactory, brandedSalt, mineFor, tokenInitCodeHash, ZERO_GUARD };
