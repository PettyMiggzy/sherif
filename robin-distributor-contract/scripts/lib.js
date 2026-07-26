// Shared helpers for the ops scripts (deploy/load/set-unit/plan/distribute).
// Plain ethers v6 + legacy (type-0) txs, because Robinhood Chain has no EIP-1559.
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");

const CHAIN = {
  id: Number(process.env.CHAIN_ID || 4663),
  name: "Robinhood Chain",
  rpc: process.env.ROBINHOOD_RPC || "https://robinhoodchain.blockscout.com/api/eth-rpc",
  explorer: process.env.EXPLORER_URL || "https://robinhoodchain.blockscout.com",
};

function getProvider() {
  return new ethers.JsonRpcProvider(CHAIN.rpc, { chainId: CHAIN.id, name: CHAIN.name }, { staticNetwork: true });
}

function getWallet(provider) {
  let pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY not set in .env (the owner/funder wallet).");
  pk = pk.trim();
  if (!pk.startsWith("0x")) pk = "0x" + pk;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("PRIVATE_KEY is not a valid 32-byte hex key.");
  return new ethers.Wallet(pk, provider);
}

async function legacyOverrides(provider, extra = {}) {
  const fee = await provider.getFeeData();
  const gasPrice = process.env.GAS_PRICE_WEI ? BigInt(process.env.GAS_PRICE_WEI)
    : (fee.gasPrice ?? ethers.parseUnits("0.1", "gwei"));
  return { type: 0, gasPrice, ...extra };
}

// Gas price pinned to the chain's baseFee (which is what real txs here pay),
// times a small safety buffer so a legacy tx still gets included.
async function baseFeeGasPrice(provider) {
  if (process.env.GAS_PRICE_WEI) return BigInt(process.env.GAS_PRICE_WEI);
  const bufferMilli = BigInt(Math.round(Number(process.env.GAS_BUFFER || "1.25") * 1000));
  const blk = await provider.getBlock("latest");
  if (blk && blk.baseFeePerGas != null && blk.baseFeePerGas > 0n) {
    return (blk.baseFeePerGas * bufferMilli) / 1000n;
  }
  const fee = await provider.getFeeData();
  return fee.gasPrice ?? ethers.parseUnits("0.1", "gwei");
}

async function baseFeeOverrides(provider, extra = {}) {
  return { type: 0, gasPrice: await baseFeeGasPrice(provider), ...extra };
}

function loadDisperseArtifact() {
  const p = path.join(ROOT, "artifacts", "contracts", "Disperse.sol", "Disperse.json");
  if (!fs.existsSync(p)) throw new Error("Disperse artifact missing — run `npm run compile` first.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function getDisperse(addressOrNull, runner) {
  const art = loadDisperseArtifact();
  const addr = addressOrNull || process.env.DISPERSE_ADDRESS;
  if (!addr) throw new Error("DISPERSE_ADDRESS not set (deploy Disperse first: npm run deploy:disperse).");
  return new ethers.Contract(addr, art.abi, runner);
}

// Robinhood Chain returns "Balance not found" for never-funded addresses.
async function safeGetBalance(provider, address) {
  try {
    return await provider.getBalance(address, "latest");
  } catch (e) {
    let blob = (e && (e.message || "")) + " ";
    try { blob += JSON.stringify(e, Object.getOwnPropertyNames(e)); } catch { /* ignore */ }
    if (/balance not found|not found|does not exist|no balance/i.test(blob)) return 0n;
    throw e;
  }
}

function loadRecipients() {
  const file = path.join(ROOT, "recipients.json");
  if (!fs.existsSync(file)) throw new Error("recipients.json missing — run `npm run build:recipients` first.");
  const arr = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("recipients.json is empty.");
  let list = arr.map((a) => ethers.getAddress(a));
  const max = Number(process.env.MAX_WALLETS || 0);   // 0 = all; else fund only the first N
  if (max > 0 && list.length > max) list = list.slice(0, max);
  return list;
}

function loadArtifact() {
  const p = path.join(ROOT, "artifacts", "contracts", "RobinDistributor.sol", "RobinDistributor.json");
  if (!fs.existsSync(p)) throw new Error("Artifact missing — run `npm run compile` first.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function getContract(addressOrNull, runner) {
  const art = loadArtifact();
  const addr = addressOrNull || process.env.CONTRACT_ADDRESS;
  if (!addr) throw new Error("CONTRACT_ADDRESS not set (put it in .env after deploying).");
  return new ethers.Contract(addr, art.abi, runner);
}

// The increment ($0.0000814 by default) in wei. Priority: INCREMENT_WEI >
// INCREMENT_ETH > (INCREMENT_USD / ETH_USD), with ETH_USD from env or CoinGecko.
async function resolveUnitWei() {
  if (process.env.INCREMENT_WEI) return BigInt(process.env.INCREMENT_WEI);
  if (process.env.INCREMENT_ETH) {
    const wei = BigInt(Math.round(Number(process.env.INCREMENT_ETH) * 1e18));
    if (wei <= 0n) throw new Error("INCREMENT_ETH rounds to 0 wei");
    return wei;
  }
  const incUsd = Number(process.env.INCREMENT_USD || "0.0000814");
  const ethUsd = await getEthUsd();
  const wei = BigInt(Math.round((incUsd / ethUsd.price) * 1e18));
  if (wei <= 0n) throw new Error("increment rounds to 0 wei");
  return wei;
}

async function getEthUsd() {
  if (process.env.ETH_USD) {
    const v = Number(process.env.ETH_USD);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`Bad ETH_USD: ${process.env.ETH_USD}`);
    return { price: v, source: "ETH_USD env" };
  }
  const url = process.env.PRICE_URL || "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Price source ${r.status}. Set ETH_USD in .env to skip the API.`);
  const j = await r.json();
  const v = j?.ethereum?.usd;
  if (!Number.isFinite(v) || v <= 0) throw new Error("Bad price payload. Set ETH_USD in .env.");
  return { price: v, source: url };
}

module.exports = {
  CHAIN, getProvider, getWallet, legacyOverrides, baseFeeOverrides, baseFeeGasPrice,
  safeGetBalance, loadRecipients, loadArtifact, getContract,
  loadDisperseArtifact, getDisperse, resolveUnitWei, getEthUsd, ethers,
};
