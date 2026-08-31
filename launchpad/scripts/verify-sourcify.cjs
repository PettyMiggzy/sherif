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

// THE LIVE STACK, as read back off the chain -- not copied from a deploy log.
//
// This list was stale and it is the kind of stale that wastes an afternoon: it pointed at an EARLIER
// generation of the pad whose addresses still hold code, so every call succeeded and verified contracts
// nobody uses. If you are adding to it, take the address from `deploy.v2.json` or from `pad/assets/config.js`
// (which is what the live site actually calls), never from memory.
//
// The v1 entries below are already exact_match on Sourcify and are kept so a re-run is a no-op that proves
// it, rather than a gap somebody has to re-derive. The v2 + staking entries are the ones that were missing.
const TARGETS = [
  // ── v2 pad (what the site launches through today) ──────────────────────────────────────────────
  { key: "padFactoryV2",        addr: "0xD41479DE442366e0358Fd74Bf4a5911eBbF3055A", sol: "contracts/CurvePadFactory.sol",          name: "CurvePadFactory" },
  { key: "padRouterV2",         addr: "0x7e3BbfddFd8B18b789710a6E419B12Dee1E9B9b1", sol: "contracts/PadRouter.sol",                name: "PadRouter" },
  { key: "launchTokenDeployer", addr: "0x8E1eC483a782E2f1E9Ec8cB32ad7703ccDE3a165", sol: "contracts/deployers/CurveDeployers.sol", name: "LaunchTokenDeployer" },
  { key: "curvePoolDeployer",   addr: "0xe465B69119E1586E484ac50351722Bac30a48d61", sol: "contracts/deployers/CurveDeployers.sol", name: "CurvePoolDeployer" },
  { key: "bondDeployer",        addr: "0x32371DC90F1FE4e7c350f35d010F130ed1CAb536", sol: "contracts/deployers/CurveDeployers.sol", name: "BondDeployer" },
  // ── staking ───────────────────────────────────────────────────────────────────────────────────
  { key: "tierStakingFactory",  addr: "0x237901667ff38CF4ec6009676E480ba71ac1c6AE", sol: "contracts/RobinTierStakingFactory.sol",  name: "RobinTierStakingFactory" },
  { key: "robinTierStaking",    addr: "0x713F0F1a2ACB98E7d2E5d6Ff706A1413aa814C10", sol: "contracts/RobinTierStaking.sol",         name: "RobinTierStaking" },
  // ── v1 pad (still live, still serves every coin launched before the v2 deploy) ─────────────────
  { key: "padRouter",           addr: "0xA6BaAB820809C7fC8350311776627298f91F07eC", sol: "contracts/PadRouter.sol",                name: "PadRouter" },
  { key: "padFactory",          addr: "0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074", sol: "contracts/CurvePadFactory.sol",          name: "CurvePadFactory" },
  { key: "rewardVault",         addr: "0x03d5d26E492B288e62D897E7dde91af3CceB4347", sol: "contracts/RewardVault.sol",              name: "RewardVault" },
  { key: "floorCoopFactory",    addr: "0x564EDF561Bed46C972d5D44D84f5FAc9C5118668", sol: "contracts/FloorCoopFactory.sol",         name: "FloorCoopFactory" },
  { key: "platformSplitter",    addr: "0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a", sol: "contracts/PlatformFeeSplitter.sol",      name: "PlatformFeeSplitter" },
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
