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
  { addr: "0x7d0c7122E26a75A9f0bd753e84c6115CAfE3Fd9F", sol: "contracts/PadRouter.sol",                name: "PadRouter" },
  { addr: "0x7E9E3BC24013e6f607e89c52E619B6FD77334DC2", sol: "contracts/CurvePadFactory.sol",          name: "CurvePadFactory" },
  { addr: "0x0F07dC315e332084129c1D00bEbADAb05edf79Dc", sol: "contracts/RewardVault.sol",              name: "RewardVault" },
  { addr: "0x26aBF8443C30AA2913b9f94B89787d38146C825b", sol: "contracts/FloorCoopFactory.sol",         name: "FloorCoopFactory" },
  { addr: "0xAc918cd2BF3affFEc81A4f55238539d7eBFd156f", sol: "contracts/PlatformFeeSplitter.sol",      name: "PlatformFeeSplitter" },
  { addr: "0xAcaeB153312CFf7B82C33a5a43604c566dbbe8c3", sol: "contracts/deployers/CurveDeployers.sol", name: "LaunchTokenDeployer" },
  { addr: "0x441bA3270B9EF2f15C603D384609D1a6Ef98e428", sol: "contracts/deployers/CurveDeployers.sol", name: "CurvePoolDeployer" },
  { addr: "0x5049f2CCa88E62990515155c745e814a53cfb862", sol: "contracts/deployers/CurveDeployers.sol", name: "BondDeployer" },
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
