/* eslint-disable no-console */
// Verify the LIVE Robin Labs stack via Sourcify v2 → Blockscout auto-imports the match.
//
//   node scripts/verify-sourcify.cjs           # verify all 8
//   node scripts/verify-sourcify.cjs padRouter # just one (by key)
//
// Why Sourcify (not `hardhat verify`): the robinhoodchain.blockscout.com verifier is heavily
// overloaded (a rival launchpad's bot floods it) and its Etherscan/standard-input paths reject
// our contracts. Sourcify is a separate, reliable service that (a) supports Robinhood Chain
// (chainId 4663), (b) matches sources by keccak so it honors the exact bytes — crucial because
// these contracts were deployed from Windows (CRLF line endings) — and (c) is auto-imported by
// Blockscout, so a Sourcify match shows up as "verified" on the explorer (name tags, Read/Write).
//
// No private key needed. Sourcify fetches the deployed bytecode itself via its own RPC.
const fs = require("fs"), path = require("path");
const SF = "https://sourcify.dev/server";
const BS = "https://robinhoodchain.blockscout.com";
const CHAIN = "4663";
const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { key: "padRouter",           addr: "0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F", sol: "contracts/PadRouter.sol",                 name: "PadRouter" },
  { key: "padFactory",          addr: "0x7E9E3BC24013e6f607e89c52E619B6FD77334DC2", sol: "contracts/CurvePadFactory.sol",           name: "CurvePadFactory" },
  { key: "rewardVault",         addr: "0x0F07dC315e332084129c1D00bEbADAb05edf79Dc", sol: "contracts/RewardVault.sol",               name: "RewardVault" },
  { key: "floorCoopFactory",    addr: "0x26aBF8443C30AA2913b9f94B89787d38146C825b", sol: "contracts/FloorCoopFactory.sol",          name: "FloorCoopFactory" },
  { key: "platformSplitter",    addr: "0xAc918cd2BF3affFEc81A4f55238539d7eBFd156f", sol: "contracts/PlatformFeeSplitter.sol",       name: "PlatformFeeSplitter" },
  { key: "launchTokenDeployer", addr: "0xAcaeB153312CFf7B82C33a5a43604c566dbbe8c3", sol: "contracts/deployers/CurveDeployers.sol",  name: "LaunchTokenDeployer" },
  { key: "curvePoolDeployer",   addr: "0x441bA3270B9EF2f15C603D384609D1a6Ef98e428", sol: "contracts/deployers/CurveDeployers.sol",  name: "CurvePoolDeployer" },
  { key: "bondDeployer",        addr: "0x5049f2CCa88E62990515155c745e814a53cfb862", sol: "contracts/deployers/CurveDeployers.sol",  name: "BondDeployer" },
];

function loadInput(t) {
  const dbg = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, t.sol, `${t.name}.dbg.json`), "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.resolve(ARTIFACTS, t.sol, dbg.buildInfo), "utf8"));
  return { stdJsonInput: bi.input, compilerVersion: bi.solcLongVersion, contractIdentifier: `${t.sol}:${t.name}` };
}

async function alreadyOnSourcify(t) {
  try { const s = await (await fetch(`${SF}/v2/contract/${CHAIN}/${t.addr}`)).json(); return s && (s.match === "exact_match" || s.match === "match"); }
  catch { return false; }
}

async function verifyOne(t) {
  if (await alreadyOnSourcify(t)) { console.log(`  ✓ already on Sourcify  ${t.name}`); return "already"; }
  const body = loadInput(t);
  let vid;
  for (let a = 0; a < 6 && !vid; a++) {
    const r = await fetch(`${SF}/v2/verify/${CHAIN}/${t.addr}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (r.status === 202) { vid = JSON.parse(txt).verificationId; break; }
    if (/already/i.test(txt)) { console.log(`  ✓ already verified     ${t.name}`); return "already"; }
    console.log(`  … ${t.name} submit ${r.status}: ${txt.slice(0, 80)} (retry)`);
    await sleep(6000);
  }
  if (!vid) { console.log(`  ❌ ${t.name} could not submit`); return "fail"; }
  for (let i = 0; i < 45; i++) {
    await sleep(4000);
    const s = await (await fetch(`${SF}/v2/verify/${vid}`)).json();
    if (s.isJobCompleted) {
      const m = s.contract && s.contract.match;
      if (m) { console.log(`  ✅ ${t.name.padEnd(20)} ${m}`); return "ok"; }
      console.log(`  ❌ ${t.name.padEnd(20)} no match  ${JSON.stringify(s.error || s).slice(0, 120)}`); return "fail";
    }
  }
  console.log(`  ⏳ ${t.name} still compiling (check later)`); return "pending";
}

async function main() {
  const only = process.argv[2];
  const queue = only ? TARGETS.filter((t) => t.key === only || t.name === only) : TARGETS;
  console.log(`Sourcify v2 → ${queue.length} contract(s) on chain ${CHAIN}\n`);
  // submit+poll in parallel (Sourcify is reliable and handles concurrency)
  const results = await Promise.all(queue.map((t) => verifyOne(t)));
  const ok = results.filter((r) => r === "ok" || r === "already").length;
  console.log(`\ndone: ${ok}/${queue.length} on Sourcify. Blockscout auto-imports within ~a minute.`);
  console.log(`explorer: ${BS}/address/${TARGETS[0].addr}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
