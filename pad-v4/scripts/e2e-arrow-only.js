const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const { mineHookSalt, hookInitCode } = require("./mine");
const { brandedTokenSalt, predictPadToken } = require("../test/helpers/brand");

const abi = ethers.AbiCoder.defaultAbiCoder();
const TS = 100;

function leafOf(index, account, amount) {
  return ethers.keccak256(ethers.concat([ethers.keccak256(abi.encode(["uint256", "address", "uint256"], [index, account, amount]))]));
}
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}
function buildLayers(leaves) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const top = layers[layers.length - 1], next = [];
    for (let i = 0; i < top.length; i += 2) next.push(i + 1 < top.length ? hashPair(top[i], top[i + 1]) : top[i]);
    layers.push(next);
  }
  return layers;
}
function getProof(layers, index) {
  const proof = []; let idx = index;
  for (let l = 0; l < layers.length - 1; l++) { const p = idx ^ 1; if (p < layers[l].length) proof.push(layers[l][p]); idx >>= 1; }
  return proof;
}

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "pad", "js", "deploy.local.json"), "utf8"));
  const [, , creatorA, , , buyer1, buyer2] = await ethers.getSigners();
  const arrowLauncher = await ethers.getContractAt("ArrowLauncher", d.contracts.arrowLauncher);
  const TokenF = await ethers.getContractFactory("PadToken");
  const HookF = await ethers.getContractFactory("RobinFeeHook");

  console.log("Full Arrow migration launch — instant buyout + graduate + airdrop, real holders claim");
  const arrowCurveSupply = 730_000_000n * 10n ** 18n, arrowReserveSupply = 270_000_000n * 10n ** 18n;
  const arrowCfg = {
    name: "Robin Migrated", symbol: "RMIGR", decimals: 18,
    supply: arrowCurveSupply + arrowReserveSupply, curveSupply: arrowCurveSupply, reserveSupply: arrowReserveSupply,
    tickSpacing: TS, startTickMag: 0, creator: creatorA.address, noPoolForever: false, lpFee: 10000,
  };
  const arrowTokenSalt = await brandedTokenSalt(d.contracts.deterministicDeployer, d.contracts.curveFactory, arrowCfg, ethers.id("arrow-demo"));
  const arrowPredictedToken = predictPadToken(d.contracts.deterministicDeployer, d.contracts.curveFactory, arrowCfg, arrowTokenSalt, TokenF.bytecode);
  const { salt: arrowHookSalt } = mineHookSalt(
    d.contracts.deterministicDeployer,
    hookInitCode(HookF.bytecode, d.contracts.poolManager, d.contracts.curveFactory, d.contracts.feeWalletRegistry, arrowPredictedToken)
  );
  const arrowCurveSalt = ethers.id("arrow-demo-curve");
  const holderEntries = [
    { index: 0, account: buyer1.address, amount: 300_000_000n * 10n ** 18n },
    { index: 1, account: buyer2.address, amount: 250_000_000n * 10n ** 18n },
  ];
  const holderLayers = buildLayers(holderEntries.map((e) => leafOf(e.index, e.account, e.amount)));
  const holderRoot = holderLayers[holderLayers.length - 1][0];
  const rc = await (await arrowLauncher.connect(creatorA).launch(
    arrowCfg, arrowTokenSalt, arrowHookSalt, arrowCurveSalt, holderRoot, { value: ethers.parseEther("8") }
  )).wait();
  const parsed = rc.logs.map((l) => { try { return arrowLauncher.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "ArrowLaunched");
  const { token: arrowToken, curve: arrowCurveAddr, distributor: distributorAddr } = parsed.args;
  const arrowCurve = await ethers.getContractAt("RobinCurveV4", arrowCurveAddr);
  console.log("RMIGR token:", arrowToken, "graduated:", await arrowCurve.graduated());
  const dist = await ethers.getContractAt("ArrowDistributor", distributorAddr);
  const arrowTok = await ethers.getContractAt("PadToken", arrowToken);
  for (const e of holderEntries) {
    await (await dist.claim(e.index, e.account, e.amount, getProof(holderLayers, e.index))).wait();
  }
  console.log("holder1 RMIGR balance:", (await arrowTok.balanceOf(buyer1.address)).toString());
  console.log("holder2 RMIGR balance:", (await arrowTok.balanceOf(buyer2.address)).toString());
  console.log("creator RMIGR balance (must be 0 — no dev bag):", (await arrowTok.balanceOf(creatorA.address)).toString());
}

// Flaky local-devnet HTTP connection resets (UND_ERR_SOCKET "other side closed") have been observed
// against this sandbox's loopback RPC on the very first call of a fresh script process, unrelated to any
// on-chain revert (nothing reaches the Hardhat node's own log when it happens). Retrying the whole script is
// safe here — nothing below has side effects until the ArrowLauncher.launch() tx itself is broadcast, and a
// broadcast that reverted or never reached the node costs no state (a fresh salt/tag would be needed only if
// a PRIOR attempt had actually succeeded on-chain, which the error path here means it didn't).
async function withRetry(fn, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts) throw e;
      console.log(`attempt ${i} failed (${e.code || e.message}) — retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
withRetry(main).catch((e) => { console.error(e); process.exit(1); });
