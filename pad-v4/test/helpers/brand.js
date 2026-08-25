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
const CFG_TUPLE = "(string,string,uint8,uint256,uint256,uint256,int24,int24,address)";
function bindSalt(cfg, tokenSalt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [CFG_TUPLE, "bytes32"],
      [[cfg.name, cfg.symbol, cfg.decimals, cfg.supply, cfg.curveSupply, cfg.reserveSupply, cfg.tickSpacing, cfg.startTickMag, cfg.creator], tokenSalt]
    )
  );
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
async function brandedTokenSalt(deployerAddr, factoryAddr, cfg, baseSalt, extraOk) {
  const TokenF = await ethers.getContractFactory("PadToken");
  const init = tokenInitCode(TokenF.bytecode, cfg, factoryAddr);
  const seed = baseSalt ?? ethers.id(`${cfg.symbol}-${cfg.name}-${factoryAddr}`);
  const key = `${deployerAddr}|${ethers.keccak256(init)}|${seed}|${extraOk ? "x" : ""}`;
  if (_cache.has(key)) return _cache.get(key);

  // `extraOk` is evaluated INSIDE the mining loop (only on a suffix hit), so a stock pad's second
  // constraint costs one extra comparison per hit rather than a discarded 65k-try pass.
  const salt = mineTokenSalt(deployerAddr, init, seed, {
    ...(extraOk ? { accept: extraOk } : {}),
    saltWrap: (cand) => bindSalt(cfg, cand),
  }).salt;
  _cache.set(key, salt);
  return salt;
}

module.exports = { brandedTokenSalt, tokenInitCode, bindSalt };
