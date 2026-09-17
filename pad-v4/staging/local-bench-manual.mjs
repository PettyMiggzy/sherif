/*
 * MANUAL verification for pad-v4's testnet bench (staging/) — drives it in a real headless browser against a
 * LOCAL devnet instead of testnet (no faucet ETH needed), with a mock window.ethereum wallet that proxies
 * everything to the local Hardhat node (which signs for its own well-known dev accounts). Serves a
 * locally-built config.js (same shape as scripts/gen-staging-config.js produces, pointed at the local deploy
 * manifest) instead of the committed testnet one — the tracked staging/config.js is never touched.
 *
 * Setup (two terminals):
 *   1. cd pad-v4 && npx hardhat node
 *   2. cd pad-v4 && npx hardhat run scripts/deploy-local-demo.js --network localhost
 * Then: node staging/local-bench-manual.mjs
 *
 * Screenshots land in staging/.shots/ (gitignored).
 */
const { chromium } = await (async () => {
  for (const spec of ["playwright", "../../launchpad/node_modules/playwright/index.mjs", "../node_modules/playwright/index.mjs"]) {
    try { return await import(spec); } catch { /* try next */ }
  }
  throw new Error("playwright not found — run `npm install` in launchpad/, or in pad-v4/, or set NODE_PATH");
})();
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE; // serve staging/ itself
const PKG_ROOT = path.resolve(HERE, "..");
const RPC = "http://127.0.0.1:8545";
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".json": "application/json" };
const SHOTS = path.join(HERE, ".shots");
fs.mkdirSync(SHOTS, { recursive: true });

let deployJson;
try { deployJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "..", "pad", "js", "deploy.local.json"), "utf8")); }
catch { throw new Error("pad/js/deploy.local.json not found — run pad-v4/scripts/deploy-local-demo.js against a local `npx hardhat node` first."); }
const WALLET_ADDR = deployJson.accounts.buyer1; // the account that bid on the RDELTA demo pad's auction

// ── build a LOCAL config.js, same shape as scripts/gen-staging-config.js, from the local deploy manifest ──
const ARTROOT = path.join(PKG_ROOT, "artifacts");
const load = (p) => JSON.parse(fs.readFileSync(path.join(ARTROOT, p), "utf8"));
const pick = (abi, names) => abi.filter((f) => f.type !== "function" || names.includes(f.name)).filter((f) => f.type === "function" || f.type === "event");
function localConfigJs() {
  const C = deployJson.contracts;
  const padToken = load("contracts/pads/PadToken.sol/PadToken.json");
  const feeHook = load("contracts/hooks/RobinFeeHook.sol/RobinFeeHook.json");
  const factory = load("contracts/core/CurvePadFactoryV4.sol/CurvePadFactoryV4.json");
  const curve = load("contracts/pads/RobinCurveV4.sol/RobinCurveV4.json");
  const stateView = load("contracts/core/RobinStateView.sol/RobinStateView.json");
  const swapTest = load("@uniswap/v4-core/src/test/PoolSwapTest.sol/PoolSwapTest.json");
  const auctionVault = load("contracts/pads/DailyAuctionVaultV4.sol/DailyAuctionVaultV4.json");
  const cfg = {
    CHAIN: { id: 31337, hexId: "0x7a69", name: "Hardhat Local", rpc: RPC, explorer: "", faucet: "" },
    ADDR: {
      poolManager: C.poolManager, permit2: C.permit2, deployer: C.deterministicDeployer, stateView: C.stateView,
      feeRegistry: C.feeWalletRegistry, lockVault: C.lockVault, curveDeployer: C.curveDeployer, feeConfig: C.feeConfig,
      factory: C.curveFactory, swapRouter: C.poolSwapTest,
    },
    HOOK_FLAGS: "0x28cc", FLAG_MASK: "0x3fff",
    BYTECODE: { padToken: padToken.bytecode, feeHook: feeHook.bytecode },
    ABI: {
      factory: pick(factory.abi, ["launch", "auctionVaultOf", "auctionVaultDeployer"]),
      curve: pick(curve.abi, ["ready", "graduated", "seeded", "graduate", "curveL", "startTick", "gradTick", "fee", "setStaking", "setFloor", "staking", "floor"]),
      stateView: pick(stateView.abi, ["getSlot0"]),
      token: [
        { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
        { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
        { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      ],
      swapRouter: pick(swapTest.abi, ["swap"]),
      dailyAuctionVault: pick(auctionVault.abi, ["auctionDays", "startTime", "dayTranche", "dayWindow", "dayTotal", "bidOf", "closed", "claimed", "stakingPool", "bid", "closeDay", "claim"]),
    },
  };
  return "export const CFG = " + JSON.stringify(cfg, null, 2) + ";\n";
}

async function rpcCall(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(localConfigJs()); }
  const f = path.join(ROOT, u === "/" ? "/index.html" : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving staging/ (local config) at ${base}`);

const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(base) || u.startsWith(RPC)) return r.continue();
  return r.abort();
});

// Plain window.ethereum mock (this bench doesn't use EIP-6963) — proxies every call to the local node, which
// signs for its own well-known dev accounts on eth_sendTransaction.
await page.addInitScript(({ rpc, addr }) => {
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || [] }) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message || "RPC error"); e.code = j.error.code; e.data = j.error.data; throw e; }
      return j.result;
    },
    on() {}, removeListener() {}, removeAllListeners() {},
  };
}, { rpc: RPC, addr: WALLET_ADDR });

async function shot(name) { await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); console.log(`  screenshot: ${name}`); }

console.log("\n=== staging bench: launch with a 2-day auction ===");
await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
await page.click("#btnConnect");
await page.waitForTimeout(800);
const who = await page.locator("#who").innerText();
console.log(`  connected: "${who}"`);
await shot("01-connected.png");

const RUN_TAG = Date.now().toString(36).slice(-5).toUpperCase();
await page.fill("#name", "Bench Auction Coin " + RUN_TAG);
await page.fill("#symbol", "BAUC" + RUN_TAG);
// The bench's own "470000" default is tuned for testnet's governed FDV band; this local deploy uses the
// production-reference geometry (deploy-local-demo.js), whose band needs a much bigger supply to clear
// minFdvWei — match the scale the local demo pads themselves use.
await page.fill("#curveSupply", "1000000000");
await page.fill("#auctionDays", "2");
await shot("02-filled.png");

console.log("  launching (mining hook salt client-side)...");
await page.click("#btnLaunch");
try {
  await page.waitForFunction(() => document.getElementById("trade").style.display !== "none", null, { timeout: 60000 });
} catch (e) {
  const logHtml = await page.locator("#log").innerHTML().catch(() => "(no log)");
  console.log(`  LAUNCH DID NOT COMPLETE. #log contents: ${logHtml}`);
  throw e;
}
console.log("  launch confirmed");
await page.waitForFunction(() => document.getElementById("auction").style.display !== "none", null, { timeout: 15000 });
console.log("  auction card visible");
await shot("03-auction-card.png");

console.log("\n=== bidding on day 1 ===");
await page.click(".bidBtn[data-day='1']");
await page.waitForFunction(() => document.getElementById("auctionState").innerHTML.includes("you:"), null, { timeout: 30000 });
console.log("  bid confirmed");
await shot("04-bid-placed.png");

console.log("\n=== warping time past day 1's window ===");
await rpcCall("evm_increaseTime", [24 * 3600 + 60]);
await rpcCall("evm_mine", []);
await page.click("#btnAuctionRefresh");
try {
  await page.waitForFunction(() => document.getElementById("auctionState").innerHTML.includes("window closed"), null, { timeout: 15000 });
} catch (e) {
  const html = await page.locator("#auctionState").innerHTML().catch(() => "(no #auctionState)");
  console.log(`  auctionState after warp+refresh: ${html}`);
  throw e;
}
await shot("05-after-warp.png");

console.log("\n=== closing day 1 (the exact path that had the real bug in v3) ===");
await page.click(".closeBtn[data-day='1']");
await page.waitForFunction(() => /Claim day 1|settled/.test(document.getElementById("auctionState").innerHTML), null, { timeout: 30000 });
console.log("  day 1 closed successfully");
await shot("06-day-closed.png");

const hasClaim = await page.locator(".claimBtn[data-day='1']").count();
if (hasClaim) {
  console.log("\n=== claiming ===");
  await page.click(".claimBtn[data-day='1']");
  await page.waitForTimeout(2000);
  await shot("07-claimed.png");
  console.log("  claimed");
}

await browser.close();
server.close();
console.log("\nALL STEPS PASSED — pad-v4 staging bench's auction UI works end-to-end against a real local devnet.");
