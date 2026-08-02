/* eslint-disable no-console */
// Push each contract's Sourcify match into robinhoodchain.blockscout.com via its `via/sourcify`
// endpoint (uploads metadata + sources; Blockscout matches through Sourcify, honoring the exact
// CRLF bytes). Retries through the explorer's intermittent 500s. Run AFTER verify-sourcify.cjs.
const fs = require("fs"), path = require("path");
const BS = "https://robinhoodchain.blockscout.com";
const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");
const ts = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { addr: "0xA6BaAB820809C7fC8350311776627298f91F07eC", sol: "contracts/PadRouter.sol",                name: "PadRouter" },
  { addr: "0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074", sol: "contracts/CurvePadFactory.sol",          name: "CurvePadFactory" },
  { addr: "0x03d5d26E492B288e62D897E7dde91af3CceB4347", sol: "contracts/RewardVault.sol",              name: "RewardVault" },
  { addr: "0x564EDF561Bed46C972d5D44D84f5FAc9C5118668", sol: "contracts/FloorCoopFactory.sol",         name: "FloorCoopFactory" },
  { addr: "0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a", sol: "contracts/PlatformFeeSplitter.sol",      name: "PlatformFeeSplitter" },
  { addr: "0xb3748cB6ba4e47b885f8333aCa8C004A4657383d", sol: "contracts/deployers/CurveDeployers.sol", name: "LaunchTokenDeployer" },
  { addr: "0x020524511aD8B99828b19DA0FD3Bb7BE919A080c", sol: "contracts/deployers/CurveDeployers.sol", name: "CurvePoolDeployer" },
  { addr: "0x8B04d9e55C904d6D371eA6e81ecb2a0911843AD3", sol: "contracts/deployers/CurveDeployers.sol", name: "BondDeployer" },
];

function filesFor(t) {
  const dbg = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, t.sol, `${t.name}.dbg.json`), "utf8"));
  const bi = JSON.parse(fs.readFileSync(path.resolve(ARTIFACTS, t.sol, dbg.buildInfo), "utf8"));
  const metaStr = bi.output.contracts[t.sol][t.name].metadata;
  const meta = JSON.parse(metaStr);
  const files = { "metadata.json": metaStr };
  for (const src of Object.keys(meta.sources)) files[src] = bi.input.sources[src].content;
  return files;
}
async function verified(addr) {
  try { const j = await (await fetch(`${BS}/api?module=contract&action=getsourcecode&address=${addr}`)).json(); const r = (j.result && j.result[0]) || {}; return !!(r.ABI && r.ABI !== "Contract source code not verified"); } catch { return false; }
}
async function push(t) {
  const files = filesFor(t);
  const fd = new FormData();
  let i = 0;
  fd.append(`files[${i++}]`, new Blob([files["metadata.json"]], { type: "application/json" }), "metadata.json");
  for (const [name, content] of Object.entries(files)) {
    if (name === "metadata.json") continue;
    fd.append(`files[${i++}]`, new Blob([content], { type: "text/plain" }), name.replace(/[\/@]/g, "_") + ".sol");
  }
  try { const r = await fetch(`${BS}/api/v2/smart-contracts/${t.addr}/verification/via/sourcify`, { method: "POST", headers: { Accept: "application/json" }, body: fd }); return { status: r.status, body: (await r.text()).slice(0, 90) }; }
  catch (e) { return { status: 0, body: String(e.message) }; }
}
async function importOne(t) {
  const deadline = Date.now() + 20 * 60 * 1000;
  let round = 0;
  while (Date.now() < deadline) {
    if (await verified(t.addr)) { console.log(`[${ts()}] ✅ ${t.name} on Blockscout`); return true; }
    round++;
    const s = await push(t);
    console.log(`[${ts()}] ${t.name} r${round}: ${s.status} ${s.body}`);
    if (s.status >= 200 && s.status < 500) { for (let i = 0; i < 10; i++) { await sleep(6000); if (await verified(t.addr)) { console.log(`[${ts()}] ✅ ${t.name} on Blockscout`); return true; } } }
    else await sleep(8000);
  }
  console.log(`[${ts()}] ⏳ ${t.name} not imported (explorer stayed busy)`);
  return false;
}
async function main() {
  const only = process.argv[2];
  const queue = only ? TARGETS.filter((t) => t.name === only || t.addr.toLowerCase() === (only || "").toLowerCase()) : TARGETS;
  // Each contract needs just one green window; run them in parallel so they all race for windows.
  const results = await Promise.all(queue.map((t) => importOne(t)));
  console.log(`\ndone: ${results.filter(Boolean).length}/${queue.length} on Blockscout`);
}
main().catch((e) => { console.error(e); process.exit(1); });
