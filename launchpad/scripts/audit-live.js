// Live audit of the redeployed contracts. Read-only. Verifies:
//  1. Router/Factory wiring (router.factory == factory, shared WETH).
//  2. Platform sink == the platform wallet.
//  3. Ownership two-step state (owner + pendingOwner) on both.
//  4. The live factory's CurvePoolDeployer runtime bytecode == the locally
//     compiled one => every pool it mints carries the 0.5/0.5 grad logic.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { keccak256 } = ethers;

// Load ROBINHOOD_RPC without printing it.
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  const k = t.slice(0, i).trim(); if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim();
}
const RPC = process.env.ROBINHOOD_RPC || "https://robinhoodchain.blockscout.com/api/eth-rpc";

const FACTORY  = "0x44855d49E73Ad103Df51871A072FEe8709E6A2d6";
const ROUTER   = "0xAEFE708e04D3E2e9609e6bC987903b31818C2a46";
const PLATFORM = "0xCD04919a51bc0866BbA48c300465425d8fF83160";
const WETH     = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const ab = (...f) => f;
const OWN = ab("function owner() view returns (address)", "function pendingOwner() view returns (address)");
const FAC = ab(...OWN,
  "function platform() view returns (address)",
  "function router() view returns (address)",
  "function WETH() view returns (address)",
  "function curveDeployer() view returns (address)",
  "function tokenDeployer() view returns (address)",
  "function bondDeployer() view returns (address)",
  "function START_TICK_MAG() view returns (int24)",
  "function CURVE_WIDTH() view returns (int24)",
  "function MIN_GRAD_WIDTH() view returns (int24)");
const ROU = ab(...OWN, "function factory() view returns (address)", "function WETH() view returns (address)");

const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
let pass = 0, fail = 0;
const check = (name, cond, got) => { console.log(`${cond ? "  ✅" : "  ❌"} ${name}${got !== undefined ? `  (${got})` : ""}`); cond ? pass++ : fail++; };

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const net = await p.getNetwork();
  console.log(`\nChain ${net.chainId} — auditing live Robin Labs contracts\n`);

  const f = new ethers.Contract(FACTORY, FAC, p);
  const r = new ethers.Contract(ROUTER, ROU, p);

  console.log("Factory", FACTORY);
  const fOwner = await f.owner(), fPending = await f.pendingOwner();
  const platform = await f.platform(), fRouter = await f.router(), fWeth = await f.WETH();
  const cpd = await f.curveDeployer();
  check("platform sink == platform wallet", eq(platform, PLATFORM), platform);
  check("router() == PadRouter", eq(fRouter, ROUTER), fRouter);
  check("WETH() == canonical WETH", eq(fWeth, WETH), fWeth);
  console.log(`     curveDeployer ${cpd}`);
  console.log(`     owner ${fOwner}`);
  console.log(`     pendingOwner ${fPending}`);
  console.log(`     ticks: START_TICK_MAG=${await f.START_TICK_MAG()} CURVE_WIDTH=${await f.CURVE_WIDTH()} MIN_GRAD_WIDTH=${await f.MIN_GRAD_WIDTH()}`);

  console.log("\nRouter", ROUTER);
  const rFactory = await r.factory(), rWeth = await r.WETH();
  const rOwner = await r.owner(), rPending = await r.pendingOwner();
  check("factory() == CurvePadFactory (setFactory wired)", eq(rFactory, FACTORY), rFactory);
  check("WETH() == canonical WETH", eq(rWeth, WETH), rWeth);
  console.log(`     owner ${rOwner}`);
  console.log(`     pendingOwner ${rPending}`);

  console.log("\nOwnership two-step");
  const accepted = eq(fOwner, PLATFORM) && eq(rOwner, PLATFORM);
  if (accepted) {
    check("factory owner == platform (ACCEPTED)", eq(fOwner, PLATFORM), fOwner);
    check("router owner == platform (ACCEPTED)", eq(rOwner, PLATFORM), rOwner);
  } else {
    check("factory pendingOwner == platform (accept still due)", eq(fPending, PLATFORM), fPending);
    check("router pendingOwner == platform (accept still due)", eq(rPending, PLATFORM), rPending);
    console.log("     → ownership transfer initiated but NOT yet accepted (expected; accept via admin.html)");
  }

  console.log("\nGraduation logic (0.5/0.5) — bytecode identity of the live pool deployer");
  const liveCode = await p.getCode(cpd);
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..",
    "artifacts/contracts/deployers/CurveDeployers.sol/CurvePoolDeployer.json"), "utf8"));
  const localCode = artifact.deployedBytecode;
  const liveH = keccak256(liveCode), localH = keccak256(localCode);
  check("live curveDeployer runtime bytecode == locally compiled (0.5/0.5 source)", liveH === localH);
  console.log(`     live  ${liveH}`);
  console.log(`     local ${localH}`);
  console.log(`     (live code ${(liveCode.length - 2) / 2} bytes)`);

  console.log(`\n${fail === 0 ? "✅ AUDIT PASSED" : "❌ AUDIT FAILED"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("audit error:", e.message); process.exit(2); });
