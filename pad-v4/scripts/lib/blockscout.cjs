/* eslint-disable no-console */
// Blockscout NATIVE verification for the V4 curve suite (Etherscan-compatible API). Blockscout already
// holds every deployed address's bytecode on its own node, so it can verify any contract on Robinhood
// Chain (chainId 4663) without a separate Sourcify RPC.
//
// Flow: POST a solidity-standard-json-input to the V2 standard-input endpoint, then poll the contract's
// verified flag. Constructor args are auto-detected by Blockscout from the creation tx, so we never
// encode per-coin args (important: the curve/hook carry long, per-pad constructor arguments).
const fs = require("fs");
const path = require("path");

const BLOCKSCOUT = process.env.BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";
const API = `${BLOCKSCOUT}/api`;
const ARTIFACTS = path.resolve(__dirname, "..", "..", "artifacts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The per-pad contracts a curve launch creates (source path + contract name). Each launch deploys a
// token + a flag-mined fee hook + a curve controller. The permanent floor/ambush/staking are wired
// post-launch by the platform and can be verified with the same verifyAddress() call if desired.
const COIN_KINDS = {
  token: { sol: "contracts/pads/PadToken.sol", name: "PadToken" },
  hook: { sol: "contracts/hooks/RobinFeeHook.sol", name: "RobinFeeHook" },
  curve: { sol: "contracts/pads/RobinCurveV4.sol", name: "RobinCurveV4" },
  floor: { sol: "contracts/pads/RobinFloorVault.sol", name: "RobinFloorVault" },
  ambush: { sol: "contracts/pads/RobinAmbushVault.sol", name: "RobinAmbushVault" },
  staking: { sol: "contracts/pads/DualStaking.sol", name: "DualStaking" },
};

// Read the exact standard-json-input + compiler long version for a contract, via its own .dbg.json →
// build-info (so each contract uses its correct compilation even after a partial recompile).
const _cache = new Map();
function loadInput({ sol, name }) {
  const key = `${sol}:${name}`;
  if (_cache.has(key)) return _cache.get(key);
  const dbgPath = path.join(ARTIFACTS, sol, `${name}.dbg.json`);
  if (!fs.existsSync(dbgPath)) throw new Error(`missing artifact ${dbgPath} — run "npx hardhat compile" first`);
  const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.resolve(path.dirname(dbgPath), dbg.buildInfo), "utf8"));
  // Blockscout wants the solc long version prefixed with "v": v0.8.26+commit.8a97fa7a
  const compiler = bi.solcLongVersion.startsWith("v") ? bi.solcLongVersion : `v${bi.solcLongVersion}`;
  const out = { stdJson: JSON.stringify(bi.input), compiler, contractName: `${sol}:${name}` };
  _cache.set(key, out);
  return out;
}

async function isVerified(addr) {
  try {
    const r = await fetch(`${BLOCKSCOUT}/api/v2/smart-contracts/${addr}`);
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.is_verified;
  } catch { return false; }
}

// Submit + poll one address. Returns "ok" | "already" | "pending" | "fail".
async function verifyAddress({ addr, sol, name, label }) {
  const tag = (label || name || addr).toString();
  if (await isVerified(addr)) { console.log(`  ✓ already verified   ${tag}  ${addr}`); return "already"; }
  const { stdJson, compiler } = loadInput({ sol, name });

  // V2 standard-input endpoint (handles viaIR-compiled contracts that the Etherscan-compat path chokes on).
  // Constructor args are auto-detected from the creation tx, so we never encode them.
  const url = `${BLOCKSCOUT}/api/v2/smart-contracts/${addr}/verification/via/standard-input`;
  let started = false;
  for (let a = 0; a < 6 && !started; a++) {
    try {
      const fd = new FormData();
      fd.set("compiler_version", compiler);
      fd.set("autodetect_constructor_args", "true");
      fd.set("license_type", "mit");
      fd.set("files[0]", new Blob([stdJson], { type: "application/json" }), "input.json");
      const r = await fetch(url, { method: "POST", body: fd });
      const txt = await r.text();
      if (/already verified|already been verified/i.test(txt)) { console.log(`  ✓ already verified   ${tag}  ${addr}`); return "already"; }
      if (r.ok || /verification (started|already)/i.test(txt)) { started = true; break; }
      console.log(`  … ${tag} submit ${r.status}: ${txt.slice(0, 110)} (retry)`);
    } catch (e) { console.log(`  … ${tag} submit error: ${String(e.message).slice(0, 80)} (retry)`); }
    await sleep(6000 * (a + 1));
  }
  if (!started) { console.log(`  ❌ ${tag} could not submit  ${addr}`); return "fail"; }

  for (let i = 0; i < 40; i++) {
    await sleep(4000);
    if (await isVerified(addr)) { console.log(`  ✅ ${tag.padEnd(16)} verified  ${addr}`); return "ok"; }
  }
  console.log(`  ⏳ ${tag} still pending (will retry next pass)  ${addr}`);
  return "pending";
}

module.exports = { BLOCKSCOUT, API, ARTIFACTS, COIN_KINDS, loadInput, isVerified, verifyAddress, sleep };
