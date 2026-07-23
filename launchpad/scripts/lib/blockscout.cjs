/* eslint-disable no-console */
// Blockscout NATIVE verification (Etherscan-compatible API). Unlike Sourcify — which needs its own
// RPC for the chain and currently can't fetch bytecode for Robinhood Chain (chainId 4663) — Blockscout
// already holds every address's bytecode on its own node, so it can verify any deployed contract here.
//
// Flow: POST module=contract&action=verifysourcecode with a solidity-standard-json-input, get a GUID,
// then poll module=contract&action=checkverifystatus. Constructor args are auto-detected by Blockscout
// from the creation transaction, so we don't need to encode per-coin args.
const fs = require("fs");
const path = require("path");

const BLOCKSCOUT = process.env.BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";
const API = `${BLOCKSCOUT}/api`;
const ARTIFACTS = path.resolve(__dirname, "..", "..", "artifacts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The per-coin contracts every launch creates (source path + contract name). Each launch deploys a
// token + a curve; the bond is deployed later, at graduation.
const COIN_KINDS = {
  token: { sol: "contracts/LaunchToken.sol", name: "LaunchToken" },
  curve: { sol: "contracts/CurvePool.sol", name: "CurvePool" },
  bond: { sol: "contracts/Bond.sol", name: "Bond" },
};

// Read the exact standard-json-input + compiler long version for a contract, via its own .dbg.json →
// build-info (so CurvePool and LaunchToken use their correct compilation even after a partial recompile).
const _cache = new Map();
function loadInput({ sol, name }) {
  const key = `${sol}:${name}`;
  if (_cache.has(key)) return _cache.get(key);
  const dbgPath = path.join(ARTIFACTS, sol, `${name}.dbg.json`);
  if (!fs.existsSync(dbgPath)) throw new Error(`missing artifact ${dbgPath} — run "npx hardhat compile" first`);
  const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.resolve(path.dirname(dbgPath), dbg.buildInfo), "utf8"));
  // Blockscout wants the solc long version prefixed with "v": v0.8.24+commit.e11b9ed9
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

  // Blockscout's V2 standard-input endpoint. We use this rather than the Etherscan-compat
  // verifysourcecode path because that one fails "Unable to verify" on some contracts here (e.g.
  // certain viaIR-compiled ones) that this endpoint verifies fine. Constructor args are
  // auto-detected from the creation tx, so we never encode them.
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

  // The endpoint verifies asynchronously; poll the contract's verified flag.
  for (let i = 0; i < 40; i++) {
    await sleep(4000);
    if (await isVerified(addr)) { console.log(`  ✅ ${tag.padEnd(16)} verified  ${addr}`); return "ok"; }
  }
  console.log(`  ⏳ ${tag} still pending (will retry next pass)  ${addr}`);
  return "pending";
}

module.exports = { BLOCKSCOUT, API, ARTIFACTS, loadInput, isVerified, verifyAddress, sleep };
