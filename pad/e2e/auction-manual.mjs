/*
 * MANUAL verification for the daily-auction UI — drives pad/create.html + pad/token.html in a real headless
 * browser against a local devnet, with a mock EIP-6963 wallet that proxies everything to the local Hardhat
 * node (which signs for its own well-known dev accounts, so no private key is needed here). Deploy-dependent
 * and heavy (real mining, real time-warping), so it's separate from pad/e2e/pad.mjs's lighter CI-style
 * wallet-picker/module-graph checks.
 *
 * Setup (two terminals):
 *   1. cd launchpad && npx hardhat node
 *   2. cd launchpad && npx hardhat run scripts/deploy-local-demo.js --network localhost
 * Then: node pad/e2e/auction-manual.mjs
 *
 * Screenshots land in pad/e2e/.shots/ (gitignored).
 */
const { chromium } = await (async () => {
  for (const spec of ["playwright", "../../launchpad/node_modules/playwright/index.mjs"]) {
    try { return await import(spec); } catch { /* try next */ }
  }
  throw new Error("playwright not found — run `npm install` in launchpad/, or set NODE_PATH");
})();
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RPC = "http://127.0.0.1:8545";
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
const SHOTS = path.join(HERE, ".shots");
fs.mkdirSync(SHOTS, { recursive: true });

let deployJson;
try { deployJson = JSON.parse(fs.readFileSync(path.join(ROOT, "js/deploy.v3-local.json"), "utf8")); }
catch { throw new Error("pad/js/deploy.v3-local.json not found — run launchpad/scripts/deploy-local-demo.js against a local `npx hardhat node` first."); }
const WALLET_ADDR = deployJson.accounts.dev;

// Serve config.js patched to point at the local devnet — server-side text substitution, so the TRACKED file
// on disk (pad/assets/config.js) is never touched and there is no "remember to revert" step. isDeployed()
// closes over CONTRACTS in the SAME served text, so this has to be a substitution of the real file's source,
// not a separate module that re-exports around it (that would leave isDeployed() checking the original
// CONTRACTS while CHAIN/CONTRACTS themselves were overridden elsewhere — a real footgun avoided here).
const C = deployJson.contracts;
function localConfigJs() {
  const real = fs.readFileSync(path.join(ROOT, "assets/config.js"), "utf8");
  const chainBlock = `export const CHAIN = {\n  id: ${deployJson.chainId},\n  hexId: "0x${deployJson.chainId.toString(16)}",\n  name: "Hardhat Local",\n  currency: { name: "Ether", symbol: "ETH", decimals: 18 },\n  rpc: ["${deployJson.rpcUrl}"],\n  walletRpcUrls: ["${deployJson.rpcUrl}"],\n  explorer: "",\n};`;
  const patched = real
    .replace(/export const CHAIN = \{[\s\S]*?\n\};/, chainBlock)
    .replace(/weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",/, `weth: "${C.weth}",`)
    .replace(/v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",/, `v3Factory: "${C.v3Factory}",`)
    .replace(/padFactory: "0xD41479DE442366e0358Fd74Bf4a5911eBbF3055A",/, `padFactory: "${C.factory}",`)
    .replace(/padRouter: "0xA6BaAB820809C7fC8350311776627298f91F07eC",/, `padRouter: "${C.router}",`);
  if (patched === real) throw new Error("config.js substitution matched nothing — the real file's shape changed, update the regexes above");
  return patched;
}

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/assets/config.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(localConfigJs());
  }
  const f = path.join(ROOT, u === "/" ? "/index.html" : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving pad/ at ${base}`);

async function rpcCall(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

// allow the site's own origin + the local RPC; abort everything else (indexer API, dexscreener, etc.)
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (u.startsWith(base) || u.startsWith(RPC)) return r.continue();
  return r.abort();
});

// Mock EIP-6963 wallet: proxies every JSON-RPC call straight to the local Hardhat node, which signs for
// its own well-known dev accounts on eth_sendTransaction (no private key needed here).
await page.addInitScript(({ rpc, addr }) => {
  const fake = {
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
  addEventListener("eip6963:requestProvider", () => dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: { info: { uuid: "local-dev", name: "Hardhat Dev", rdns: "local.hardhat.dev", icon: "" }, provider: fake } })));
}, { rpc: RPC, addr: WALLET_ADDR });

async function shot(name) { await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); console.log(`  screenshot: ${name}`); }

// ── 1. create.html ────────────────────────────────────────────────────────────
console.log("\n=== create.html ===");
await page.goto(base + "/create.html", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);
await shot("01-create-loaded.png");

const feeNote = await page.locator("#creationFeeNote").innerText();
console.log(`  creation fee note: "${feeNote}"`);

await page.click("#connectBtn");
await page.waitForSelector("#rl-wallet-modal", { timeout: 8000 });
await page.click('#rl-wallet-modal [data-i="0"]');
await page.waitForTimeout(500);
const connected = await page.locator("#connectBtn").innerText();
console.log(`  connect button now reads: "${connected}"`);

// Unique per run — a re-run against the same (not-redeployed) devnet would otherwise re-mine the exact same
// salt for the exact same (creator, name, symbol) and collide with a token already deployed from a prior run.
const RUN_TAG = Date.now().toString(36).slice(-5).toUpperCase();
await page.fill("#name", "Test Auction Coin " + RUN_TAG);
await page.fill("#ticker", "TAUC" + RUN_TAG);

// open the auction panel and pick 2 days
await page.click("#auctionPanel summary");
await page.click('#auctionDaysPicker [data-days="2"]');
const auctionNote = await page.locator("#auctionNote").innerText();
console.log(`  auction note after picking 2 days: "${auctionNote}"`);
await shot("02-create-filled.png");

console.log("  launching (mining the 1ab5 salt client-side, can take up to ~30s)...");
await page.click("#launchBtn");
try {
  await page.waitForURL(/token\.html/, { timeout: 90000 });
} catch (e) {
  const note = await page.locator("#launchNote").innerText().catch(() => "(no note)");
  console.log(`  LAUNCH DID NOT REDIRECT. #launchNote says: "${note}"`);
  throw e;
}
const tokenUrl = new URL(page.url());
const TOKEN = tokenUrl.searchParams.get("c");
console.log(`  launched! redirected to token.html, token=${TOKEN}`);
await page.waitForTimeout(1500);
await shot("03-token-page-loaded.png");

// ── 2. token.html — auction panel ───────────────────────────────────────────
console.log("\n=== token.html — auction panel ===");
await page.waitForFunction(() => {
  const p = document.getElementById("auctionPanel");
  return p && getComputedStyle(p).display !== "none";
}, { timeout: 20000 });
console.log("  auction panel is visible");
const meta = await page.locator("#auctionMeta").innerText();
console.log(`  auction meta: "${meta}"`);
// Every secondary side panel on this page is a collapsible accordion (Buy/Sell + Bond stay open, everything
// else defaults closed, per initAccordion() in token.html) — the auction panel is no exception. Open it the
// way a real user would: click its <h3>.
await page.click("#auctionPanel > h3");
await page.waitForTimeout(200);
await shot("04-auction-panel.png");

// ── 3. bid on day 1 ──────────────────────────────────────────────────────────
console.log("\n=== bidding on day 1 ===");
await page.fill('.auc-bid-amt[data-day="1"]', "0.5");
await page.click('.auc-bid-btn[data-day="1"]');
await page.waitForFunction(() => {
  const rows = document.getElementById("auctionDayRows");
  return rows && rows.innerHTML.includes("you:");
}, { timeout: 30000 });
console.log("  bid confirmed, panel shows 'you: 0.5 ETH'");
await shot("05-bid-placed.png");

// ── 4. warp past day 1's window (direct RPC, not through the UI) ────────────
console.log("\n=== warping time past day 1's window ===");
await rpcCall("evm_increaseTime", [24 * 3600 + 60]);
await rpcCall("evm_mine", []);
console.log("  chain time advanced 24h1m");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const p = document.getElementById("auctionPanel");
  return p && getComputedStyle(p).display !== "none";
}, { timeout: 20000 });
await shot("06-after-warp.png");

// ── 5. close day 1 — THE regression check (v3's receive() bug lived exactly here) ──
console.log("\n=== closing day 1 (the exact path that had the real bug) ===");
await page.click('.auc-close-btn[data-day="1"]');
await page.waitForFunction(() => {
  const rows = document.getElementById("auctionDayRows");
  return rows && (rows.innerHTML.includes("Claim your share") || rows.innerHTML.includes("Claimed"));
}, { timeout: 30000 });
console.log("  day 1 closed successfully — claim button now showing");
await shot("07-day-closed.png");

// ── 6. claim ─────────────────────────────────────────────────────────────────
console.log("\n=== claiming ===");
await page.click('.auc-claim-btn[data-day="1"]');
await page.waitForFunction(() => {
  const rows = document.getElementById("auctionDayRows");
  return rows && rows.innerHTML.includes("Claimed");
}, { timeout: 30000 });
console.log("  claimed successfully");
await shot("08-claimed.png");

await browser.close();
server.close();
console.log("\nALL STEPS PASSED — auction UI works end-to-end against a real local devnet.");
