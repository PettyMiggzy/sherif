const { ethers } = require("hardhat");
const { mineTokenSalt } = require("../../scripts/mine");

// [brand] Since PadBrand.requireBrand, every factory REJECTS a launch whose token address does not end in
// `1ab5`, so tests can no longer pass an arbitrary `tokenSalt` — they must mine one exactly like production
// does (scripts/launch.js). This helper mirrors the PadToken init-code all three factories build on-chain
// (name, symbol, decimals, supply, factory-as-mintTo) and returns a salt that lands the branded address.
//
// Mining is ~65k keccak tries (~2s), so results are MEMOIZED per (deployer, initCodeHash, baseSalt): a suite
// that launches the same pad shape repeatedly pays for it once.
const _cache = new Map();

// The exact preimage the factories hash: keccak256(abi.encode(cfg, tokenSalt)). Mining has to reproduce it
// bit for bit or it finds addresses the factory will never deploy to. Field order and types mirror
// LaunchConfig in contracts/interfaces/ICurvePadFactoryV4.sol.
// Each factory declares its OWN `LaunchConfig` — CurvePadFactoryV4, PadFactory and StockPadFactory all have
// one and they are NOT the same shape (the stock pad has stockSeed/sqrtPriceX96/guardWindow and no
// curveSupply/startTickMag). Hardcoding one tuple here silently produced `value=null` encoding errors on the
// others, so the type is read from the factory's own ABI instead. There is exactly one source of truth for it
// and it is the contract.
// Each factory declares its OWN `LaunchConfig` — CurvePadFactoryV4, PadFactory and StockPadFactory all have
// one and they are NOT the same shape (the stock pad carries stockSeed/sqrtPriceX96/guardWindow and no
// curveSupply/startTickMag). Hardcoding a single tuple here produced `value=null` encoding failures on the
// other two across thirteen tests.
//
// So the type is never transcribed. It is read out of the compiled artifacts, and the right one is chosen by
// matching the cfg's own fields — which means it cannot drift from the contracts even if a struct changes.
const FACTORY_NAMES = ["CurvePadFactoryV4", "PadFactory", "StockPadFactory"];
let _types = null;
function launchCfgTypes() {
  if (_types) return _types;
  const { artifacts } = require("hardhat");
  _types = [];
  for (const n of FACTORY_NAMES) {
    try {
      const abi = artifacts.readArtifactSync(n).abi;
      const fn = abi.find((e) => e.type === "function" && e.name === "launch");
      if (fn && fn.inputs && fn.inputs[0] && fn.inputs[0].components) _types.push(fn.inputs[0]);
    } catch { /* a factory that is not compiled in this project simply has no type to offer */ }
  }
  return _types;
}

/// Pick the LaunchConfig whose components the given cfg actually satisfies.
function cfgTypeFor(cfg, factoryOrType) {
  if (factoryOrType) return factoryOrType.interface ? factoryOrType.interface.getFunction("launch").inputs[0] : factoryOrType;
  const keys = new Set(Object.keys(cfg || {}));
  const hit = launchCfgTypes().find((t) => t.components.every((c) => keys.has(c.name)));
  if (!hit) {
    throw new Error(
      "brand.js: no factory LaunchConfig matches this cfg (keys: " + [...keys].join(",") +
      "). Pass the factory explicitly as the last argument."
    );
  }
  return hit;
}

/// `keccak256(abi.encode(cfg, tokenSalt))` — the preimage every factory hashes before CREATE2.
function bindSalt(cfg, tokenSalt, factoryOrType) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode([cfgTypeFor(cfg, factoryOrType), "bytes32"], [cfg, tokenSalt])
  );
}

/// A `bindSalt` specialised to one cfg, for the mining hot path.
///
/// Calling bindSalt per try re-ABI-encodes a struct with two dynamic strings 65,000 times, and that — not the
/// extra keccak — is what turned a ~2s mine into one that outran a 900s suite timeout. The encoding is stable:
/// a dynamic tuple followed by a bytes32 lays out as [offset=0x40][tokenSalt][tuple data...], so the salt
/// occupies exactly bytes [32,64) and everything else is constant for a given cfg. Encode once, then per try
/// overwrite those 32 bytes and hash. One memcpy plus one keccak.
function bindSaltFast(cfg, factoryOrType) {
  const t = cfgTypeFor(cfg, factoryOrType);
  const buf = ethers.getBytes(
    ethers.AbiCoder.defaultAbiCoder().encode([t, "bytes32"], [cfg, ethers.ZeroHash])
  ).slice();
  return (tokenSalt) => {
    buf.set(ethers.getBytes(tokenSalt), 32);
    return ethers.keccak256(buf);
  };
}

function tokenInitCode(TokenBytecode, cfg, factoryAddr) {
  return ethers.concat([
    TokenBytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "uint8", "uint256", "address"],
      [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, factoryAddr]
    ),
  ]);
}

/// Mine a `tokenSalt` whose CREATE2 token address carries the `1ab5` brand suffix.
/// @param deployerAddr the DeterministicDeployer the factory uses
/// @param factoryAddr  the factory (it is the token's `mintTo` constructor arg)
/// @param cfg          the LaunchConfig (needs name, symbol, decimals, supply)
/// @param baseSalt     optional per-pad seed so two identical-config pads get DIFFERENT addresses
/// @param extraOk      optional predicate the address must ALSO satisfy (e.g. stock pads need token > stock)
async function brandedTokenSalt(deployerAddr, factoryAddr, cfg, baseSalt, extraOk, factoryOrType) {
  const TokenF = await ethers.getContractFactory("PadToken");
  const init = tokenInitCode(TokenF.bytecode, cfg, factoryAddr);
  const seed = baseSalt ?? ethers.id(`${cfg.symbol}-${cfg.name}-${factoryAddr}`);
  // The salt now depends on the WHOLE cfg, so the cache must key on the whole cfg. initCodeHash covers only
  // name/symbol/decimals/supply — two pads differing solely in creator, supply split, spacing or start tick
  // would otherwise collide here and be handed each other's salt.
  const key = `${deployerAddr}|${ethers.keccak256(init)}|${seed}|${extraOk ? "x" : ""}|${bindSalt(cfg, ethers.ZeroHash, factoryOrType)}`;
  if (_cache.has(key)) return _cache.get(key);

  // `extraOk` is evaluated INSIDE the mining loop (only on a suffix hit), so a stock pad's second
  // constraint costs one extra comparison per hit rather than a discarded 65k-try pass.
  const salt = mineTokenSalt(deployerAddr, init, seed, {
    ...(extraOk ? { accept: extraOk } : {}),
    saltWrap: bindSaltFast(cfg, factoryOrType),
  }).salt;
  _cache.set(key, salt);
  return salt;
}

/// THE one place a pad token's address is predicted off-chain.
///
/// The factories hash `keccak256(abi.encode(cfg, tokenSalt))` before CREATE2, so predicting from the raw
/// `tokenSalt` yields an address that will never exist. That is not a harmless mistake: the fee hook's
/// init-code embeds the token address, so a wrong prediction mines a hook the factory cannot reach and the
/// launch fails somewhere far away from the cause. Every call site that needs the address goes through here.
function predictPadToken(deployerAddr, factoryAddr, cfg, tokenSalt, TokenBytecode, factoryOrType) {
  const init = tokenInitCode(TokenBytecode, cfg, factoryAddr);
  return ethers.getCreate2Address(deployerAddr, bindSalt(cfg, tokenSalt, factoryOrType), ethers.keccak256(init));
}

module.exports = { brandedTokenSalt, tokenInitCode, bindSalt, bindSaltFast, predictPadToken, cfgTypeFor };
