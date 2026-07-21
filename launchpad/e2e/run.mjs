// ─────────────────────────────────────────────────────────────────────────────
// Headless end-to-end test of the REAL pad frontend — no MetaMask, no fork, no faucet.
//
//   npm run e2e            (from launchpad/)
//
// What it does, start to finish, with zero human clicking:
//   1. boots a plain hardhat node (unlimited local ETH, unlocked accounts)
//   2. deploys a genuine Uniswap v3 factory + WETH + the full pad stack to it (scripts/e2e-deploy.cjs)
//   3. stands up a "Robinhood Chain emulator" RPC proxy in front of the node that reproduces the exact
//      quirks that broke MetaMask on the real chain:
//        · eth_maxPriorityFeePerGas → -32601 (the chain doesn't implement it)
//        · eth_estimateGas → returns ~3× what the tx actually burns (the L2 over-estimates)
//        · eth_sendTransaction → rejected if it asks for more than the 2^24 (16,777,216) per-tx gas cap
//   4. serves a copy of pad/ with config.js pointed at the proxy + the fresh addresses
//   5. drives create.html in headless Chromium through an INJECTED wallet (a local unlocked key), clicks the
//      real Launch button, and asserts the coin was created — in the UI *and* on-chain.
//
// If the launch succeeds here it succeeds on Robinhood Chain: the proxy makes the local node behave like the
// real chain, so this is a faithful regression test of the legacy-tx gas fix in pad/assets/wallet.js.
// Exit code 0 = all primary checks passed.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, cp, rm, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { chromium } from "playwright";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHPAD = path.resolve(__dir, "..");
const PAD_SRC = path.resolve(LAUNCHPAD, "..", "pad");
const RUN_DIR = path.join(__dir, ".run");
const PAD_TMP = path.join(RUN_DIR, "pad");
const ADDR_OUT = path.join(RUN_DIR, "addresses.json");
const NODE_LOG = path.join(RUN_DIR, "node.log");
const SHOTS = path.join(RUN_DIR, "shots");

const NODE_PORT = +(process.env.E2E_NODE_PORT || 8545);
const PROXY_PORT = +(process.env.E2E_PROXY_PORT || 8546);
const WEB_PORT = +(process.env.E2E_WEB_PORT || 8547);
const NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const ACCT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // hardhat dev account #0 (unlocked on the node)
const CHROME = process.env.E2E_CHROME || "/opt/pw-browsers/chromium";

const CAP = 16_777_216n; // Robinhood Chain 2^24 per-transaction gas cap
// Serendipity: hardhat's EDR engine caps eth_estimateGas at this SAME 2^24 value (separate from its 60M block
// limit), so a plain local node reproduces the real chain's failure — the launch's ~36M estimate errors on the
// cap exactly as it does on Robinhood — with no help needed from the proxy. The proxy still handles the other
// case (engine returns a huge result instead of erroring) by tripling it, so the test is robust either way.
const quirks = { maxPriorityBlocked: 0, estimateOvershot: 0, estimateCapErr: 0, capRejected: 0, sends: 0 };

const log = (...a) => console.log("·", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the "Robinhood Chain emulator" JSON-RPC proxy ────────────────────────────
async function nodeCall(method, params) {
  const r = await fetch(NODE_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
  return r.json();
}
function startProxy() {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
  const srv = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload; try { payload = JSON.parse(body); } catch { res.writeHead(400, CORS); return res.end("bad json"); }
      const one = async (m) => {
        const id = m.id ?? 1;
        if (process.env.E2E_DEBUG) console.error("  rpc<", m.method, m.method === "eth_estimateGas" ? JSON.stringify(m.params?.[0]?.from || "") : "");
        if (m.method === "eth_maxPriorityFeePerGas") {
          quirks.maxPriorityBlocked++;
          return { jsonrpc: "2.0", id, error: { code: -32601, message: "the method eth_maxPriorityFeePerGas does not exist/is not available" } };
        }
        if (m.method === "eth_sendTransaction") {
          quirks.sends++;
          const gas = m.params?.[0]?.gas;
          if (gas && BigInt(gas) > CAP) {
            quirks.capRejected++;
            return { jsonrpc: "2.0", id, error: { code: -32000, message: `intrinsic gas too high — have ${BigInt(gas)}, per-tx cap ${CAP}` } };
          }
          return nodeCall(m.method, m.params).then((j) => ({ ...j, id }));
        }
        if (m.method === "eth_estimateGas") {
          const j = await nodeCall(m.method, m.params);
          if (process.env.E2E_DEBUG) console.error("  rpc> eth_estimateGas", j.result ? "result=" + BigInt(j.result) : "ERROR=" + JSON.stringify(j.error));
          // Two ways the launch estimate turns hostile, both faithful to Robinhood Chain:
          //  · node returns a result BELOW its cap → we triple it to force the L2's over-estimate
          //  · node's OWN estimate (36M+) already exceeds the 2^24 cap → it errors, exactly like the real chain
          if (j.result) { quirks.estimateOvershot++; j.result = "0x" + (BigInt(j.result) * 3n).toString(16); }
          else if (j.error) { quirks.estimateCapErr++; }
          return { ...j, id };
        }
        return nodeCall(m.method, m.params).then((j) => ({ ...j, id }));
      };
      const out = Array.isArray(payload) ? await Promise.all(payload.map(one)) : await one(payload);
      res.writeHead(200, { ...CORS, "content-type": "application/json" }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((res) => srv.listen(PROXY_PORT, "127.0.0.1", () => res(srv)));
}

// ── static file server for the staged pad copy ───────────────────────────────
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".webp": "image/webp" };
function startWeb(root) {
  const srv = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p === "/" || p.endsWith("/")) p += "index.html";
      let fp = path.join(root, p), data;
      try { data = await readFile(fp); } catch { fp += ".html"; data = await readFile(fp); }
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" }); res.end(data);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  return new Promise((res) => srv.listen(WEB_PORT, "127.0.0.1", () => res(srv)));
}

// ── stage a pad/ copy with config.js pointed at the local chain ──────────────
async function stagePad(addrs) {
  await rm(PAD_TMP, { recursive: true, force: true });
  await cp(PAD_SRC, PAD_TMP, { recursive: true });
  const cfgPath = path.join(PAD_TMP, "assets", "config.js");
  let cfg = await readFile(cfgPath, "utf8");
  cfg = cfg
    .replace(/\bid:\s*\d+/, `id: ${addrs.chainId}`)
    .replace(/hexId:\s*"0x[0-9a-fA-F]+"/, `hexId: "0x${addrs.chainId.toString(16)}"`)
    .replace(/rpc:\s*\[[^\]]*\]/, `rpc: ["${PROXY_URL}"]`);
  for (const k of ["weth", "v3Factory", "padFactory", "padRouter", "rewardVault", "floorCoopFactory", "platformSplitter"])
    cfg = cfg.replace(new RegExp(`(${k}:\\s*)"[^"]*"`), `$1"${addrs[k]}"`);
  await writeFile(cfgPath, cfg);
}

// ── injected EIP-1193 wallet (runs in the page before any app script) ────────
function walletShim({ proxyUrl, acct }) {
  let id = 1;
  const rpc = async (method, params) => {
    const r = await fetch(proxyUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params: params || [] }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message || "rpc error"); e.code = j.error.code; throw e; }
    return j.result;
  };
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [acct];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      return rpc(method, params);
    },
    on() {}, removeListener() {}, removeAllListeners() {},
  };
}

// ── process/server lifecycle ─────────────────────────────────────────────────
let node, proxy, web, browser;
async function waitRpc(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if ((await r.json()).result) return true; } catch {}
    await sleep(500);
  }
  return false;
}
function run(cmd, args, env) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: LAUNCHPAD, shell: true, stdio: "inherit", env: { ...process.env, ...env } });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} → exit ${c}`))));
    p.on("error", rej);
  });
}
async function cleanup() {
  try { await browser?.close(); } catch {}
  try { proxy?.close(); } catch {}
  try { web?.close(); } catch {}
  // kill the node's whole process group (detached leader) so nothing is left holding the port
  try { if (node?.pid) process.kill(-node.pid, "SIGKILL"); } catch { try { node?.kill("SIGKILL"); } catch {} }
}
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

// ── the test ─────────────────────────────────────────────────────────────────
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`); };

async function main() {
  await rm(RUN_DIR, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });

  log(`booting hardhat node on ${NODE_URL} …`);
  // FORK_RPC="" overrides any value in .env so hardhat.config's fork ternary falls to a PLAIN node — the E2E
  // is fully local (real Uniswap v3 is deployed from the v3-core artifact, not pulled from a fork), so it needs
  // no archive RPC, no faucet, no network at all. dotenv does not override an already-set key, so "" sticks.
  const NENV = { ...process.env, FORK_RPC: "" };
  // Spawn the hardhat binary DIRECTLY (no npx/shell wrapper) and `detached` so it leads its own process group —
  // then cleanup can kill the whole group. A shell wrapper would leave the real node orphaned on the port and
  // make re-runs flaky (SocketError / EADDRINUSE on the next run).
  const HH = path.join(LAUNCHPAD, "node_modules", ".bin", "hardhat");
  node = spawn(HH, ["node", "--port", String(NODE_PORT)], { cwd: LAUNCHPAD, stdio: ["ignore", "pipe", "pipe"], env: NENV, detached: true });
  const nlog = []; node.stdout.on("data", (d) => nlog.push(d)); node.stderr.on("data", (d) => nlog.push(d));
  const up = await waitRpc(NODE_URL);
  await writeFile(NODE_LOG, Buffer.concat(nlog.map((b) => Buffer.from(b)))).catch(() => {});
  check("hardhat node is up", up, up ? NODE_URL : "did not answer — see node.log");
  if (!up) throw new Error("node did not start");

  log("deploying real-v3 + full pad stack …");
  await run("npx", ["hardhat", "run", "scripts/e2e-deploy.cjs", "--network", "localhost"], { E2E_OUT: ADDR_OUT, FORK_RPC: "" });
  const addrs = JSON.parse(await readFile(ADDR_OUT, "utf8"));
  check("stack deployed", !!addrs.padFactory, `padFactory=${addrs.padFactory} chainId=${addrs.chainId}`);

  proxy = await startProxy(); log(`emulator proxy on ${PROXY_URL}`);
  await stagePad(addrs);
  web = await startWeb(PAD_TMP); log(`pad served on ${WEB_URL}`);

  browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await (await browser.newContext()).newPage();
  const cerr = [], perr = [];
  page.on("console", (m) => { if (m.type() === "error") cerr.push(m.text()); });
  page.on("pageerror", (e) => perr.push(e.message));
  await page.addInitScript(walletShim, { proxyUrl: PROXY_URL, acct: ACCT });

  // ---- drive create.html ----
  await page.goto(`${WEB_URL}/create.html`, { waitUntil: "domcontentloaded" });
  await page.fill("#name", "E2E Wolf");
  await page.fill("#ticker", "E2EW");
  await page.fill("#db", "0.5");
  await page.click("#connectBtn").catch(() => {});
  const connected = await page.waitForFunction(
    () => /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/.test(document.getElementById("connectBtn")?.textContent || ""),
    null, { timeout: 20000 }).then(() => true).catch(() => false);
  check("wallet connected in UI", connected, connected ? await page.textContent("#connectBtn") : "connect button never showed an address");

  await page.click("#launchBtn");
  const settled = await page.waitForFunction(() => {
    const t = document.getElementById("launchNote")?.textContent || "";
    return /Launched ✓/.test(t) || /(failed|Not enough|Couldn|revert|cancelled|isn't live)/i.test(t);
  }, null, { timeout: 90000 }).then(() => true).catch(() => false);
  const noteText = (await page.textContent("#launchNote").catch(() => "")) || "";
  await page.screenshot({ path: path.join(SHOTS, "create-after-launch.png") }).catch(() => {});
  const uiLaunched = /Launched ✓/.test(noteText);
  check("UI reports launch success", uiLaunched, settled ? noteText.trim().slice(0, 120) : "note never settled (timeout)");

  // ---- verify on-chain (direct to the node, bypassing the emulator) ----
  const node2 = new ethers.JsonRpcProvider(NODE_URL);
  const fac = new ethers.Contract(addrs.padFactory, [
    "function tokenCount() view returns (uint256)",
    "function allTokens(uint256) view returns (address)",
  ], node2);
  const count = await fac.tokenCount();
  check("a coin exists on-chain", count === 1n, `factory.tokenCount()=${count}`);
  let token = null;
  if (count > 0n) {
    token = await fac.allTokens(count - 1n);
    const erc = new ethers.Contract(token, ["function symbol() view returns (string)", "function name() view returns (string)", "function totalSupply() view returns (uint256)"], node2);
    const [sym, nm, sup] = await Promise.all([erc.symbol(), erc.name(), erc.totalSupply()]);
    check("launched token is a real ERC-20", sym === "E2EW", `name="${nm}" symbol="${sym}" supply=${ethers.formatUnits(sup, 18)}`);
  }

  // ---- verify the emulator actually reproduced the chain's constraints, and the fix survived them ----
  const hostile = quirks.estimateOvershot + quirks.estimateCapErr;
  check("estimateGas was hostile (36M+ over the 2^24 cap) yet the launch still landed", hostile > 0 && uiLaunched,
    `overshot=${quirks.estimateOvershot} capErrored=${quirks.estimateCapErr}`);
  check("the sent tx fit under the 2^24 per-tx cap", quirks.sends > 0 && quirks.capRejected === 0,
    `${quirks.sends} send(s), ${quirks.capRejected} rejected by cap, ${quirks.maxPriorityBlocked} maxPriorityFee call(s) blocked (0 = fix avoided the missing RPC)`);

  // ---- verify the coin renders on the token page (real data, not demo) ----
  if (token) {
    await page.goto(`${WEB_URL}/token.html?c=${token}`, { waitUntil: "domcontentloaded" });
    const rendered = await page.waitForFunction((sym) => (document.body.innerText || "").includes(sym), "E2EW", { timeout: 25000 })
      .then(() => true).catch(() => false);
    const demoBanner = await page.evaluate(() => !!document.getElementById("demo-banner"));
    await page.screenshot({ path: path.join(SHOTS, "token-page.png"), fullPage: true }).catch(() => {});
    check("token page renders the real coin (no demo banner)", rendered && !demoBanner,
      rendered ? (demoBanner ? "but demo banner is showing" : "ticker E2EW visible, live data") : "ticker never appeared");
  }

  if (cerr.length) log("page console errors:", cerr.slice(0, 6).join(" | "));
  if (perr.length) log("page errors:", perr.slice(0, 6).join(" | "));
}

let code = 0;
try {
  await main();
} catch (e) {
  console.error("\n✗ harness error:", e?.message || e);
  code = 1;
} finally {
  const primary = checks.filter((c) => !/token page renders/.test(c.name)); // token-page is a secondary check
  const passed = primary.filter((c) => c.ok).length;
  const failed = primary.length - passed;
  console.log(`\n${"─".repeat(70)}`);
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  (" + c.detail + ")" : ""}`);
  console.log(`${"─".repeat(70)}`);
  const green = code === 0 && failed === 0;
  console.log(green
    ? `✅ E2E PASSED — ${passed}/${primary.length} primary checks green`
    : `❌ E2E FAILED — ${code !== 0 ? "harness error before all checks ran" : failed + " primary check(s) failed"}`);
  console.log(`screenshots: ${SHOTS}`);
  await cleanup();
  process.exit(green ? 0 : 1);
}
