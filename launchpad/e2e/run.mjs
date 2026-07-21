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

  // Link Telegram — a FREE personal_sign (never a transaction, never on the payment path)
  await page.fill("#tg", "https://t.me/robinlabs_e2e");
  await page.click("#linkTg");
  await page.waitForFunction(() => /Telegram linked ✓|failed|error|cancelled/i.test(document.getElementById("launchNote")?.textContent || ""), null, { timeout: 20000 }).catch(() => {});
  const tgNote = (await page.textContent("#launchNote").catch(() => "")) || "";
  check("Telegram link via free signature works", /Telegram linked ✓/.test(tgNote), tgNote.trim().slice(0, 80));

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
    "function recordOf(address) view returns (address token, address curve, address dev, uint256 at)",
  ], node2);
  const count = await fac.tokenCount();
  check("a coin exists on-chain", count === 1n, `factory.tokenCount()=${count}`);
  let token = null, curveAddr = null;
  if (count > 0n) {
    token = await fac.allTokens(count - 1n);
    curveAddr = (await fac.recordOf(token)).curve;
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
    // the GoPlus + template safety scan (read-only) populates its panel
    const safetyOk = await page.waitForFunction(() => /Verified Robin Labs coin|Not a honeypot|Sells always open|🛡/i.test(document.getElementById("safetyBody")?.textContent || ""), null, { timeout: 15000 }).then(() => true).catch(() => false);
    check("token page shows the safety scan (GoPlus + template)", safetyOk, safetyOk ? "safety panel populated" : "safety panel stayed on 'scanning'");
  }

  // ============ FULL LIFECYCLE: buy up the curve → graduate → the Bond ============
  // The page is already on token.html?c=<token>. We drive the REAL buy + graduate buttons. The many mid-curve
  // buys needed to *reach* graduation are volume, not the thing under test, so we do those directly against the
  // router (reliable, no UI slippage guard) — but the BUY and GRADUATE clicks that matter go through the UI.
  if (token && curveAddr) {
    const owner = await node2.getSigner(ACCT); // hardhat account #0 — unlocked on the node
    const curveAbi = [
      "function minGradTick() view returns (int24)", "function gradTick() view returns (int24)",
      "function setGradTarget(int24)", "function ready() view returns (bool)",
      "function graduated() view returns (bool)", "function bond() view returns (address)",
    ];
    const curve = new ethers.Contract(curveAddr, curveAbi, owner);
    const router = new ethers.Contract(addrs.padRouter, [
      "function buy(address token, uint256 minOut) payable returns (uint256)",
      "function sell(address token, uint256 amountIn, uint256 minOutEth) returns (uint256)",
    ], owner);

    // Advance past the anti-snipe window so a normal trader can buy. The LaunchToken guard (dead window →
    // maxTx/maxWallet phases) auto-expires at launchTime + antiSnipeSecs; jumping the chain past it is the
    // faithful "a trader arrives after the opening" — without it, an immediate buy trips the guard (revert TF).
    try {
      const tok = new ethers.Contract(token, ["function windowEndsAt() view returns (uint256)"], node2);
      const winEnd = Number(await tok.windowEndsAt());
      await node2.send("evm_setNextBlockTimestamp", [winEnd + 5]);
      await node2.send("evm_mine", []);
      log(`advanced past anti-snipe window (ends @ ${winEnd})`);
    } catch (e) { log("anti-snipe advance skipped:", e.message); }

    // connect on the token page
    await page.click("#connectBtn").catch(() => {});
    await page.waitForFunction(() => /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/.test(document.getElementById("connectBtn")?.textContent || ""), null, { timeout: 20000 }).catch(() => {});

    // (1) prove the BUY button — small buy, low on the curve, well inside slippage
    await page.fill("#amtInput", "0.05");
    await page.click("#trade");
    await page.waitForFunction(() => {
      const t = document.getElementById("tradeNote")?.textContent || "";
      return /Bought ✓/.test(t) || /(failed|Not enough|Couldn|revert|slippage|cancelled)/i.test(t);
    }, null, { timeout: 60000 }).catch(() => {});
    const buyNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
    check("UI buy on the curve works", /Bought ✓/.test(buyNote), buyNote.trim().slice(0, 90));

    // (1b) prove the SELL button — exact-amount approval + router.sell (sells are never gated by the guard)
    const erc20 = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], node2);
    const held = await erc20.balanceOf(ACCT);
    const sellHuman = String(Math.max(1, Math.floor(Number(ethers.formatUnits(held, 18)) * 0.1)));
    await page.click("#tSell");
    await page.fill("#amtInput", sellHuman);
    await page.click("#trade");
    await page.waitForFunction(() => {
      const t = document.getElementById("tradeNote")?.textContent || "";
      return /Sold ✓/.test(t) || /(failed|Not enough|Couldn|revert|slippage|cancelled)/i.test(t);
    }, null, { timeout: 60000 }).catch(() => {});
    const sellNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
    check("UI sell works (approval + router.sell)", /Sold ✓/.test(sellNote), sellNote.trim().slice(0, 90));

    // (1c) prove the CREATOR controls — the dev panel shows because the connected wallet launched this coin
    const devVisible = await page.waitForFunction(() => { const d = document.getElementById("devPanel"); return d && getComputedStyle(d).display !== "none"; }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    const routerViews = new ethers.Contract(addrs.padRouter, ["function devEscrow(address) view returns (uint256)"], node2);
    const escBefore = await routerViews.devEscrow(token);
    if (devVisible) {
      await page.click('#targetSeg button[data-tg="min"]');
      await page.waitForFunction(() => /Target updated ✓|failed|error/i.test(document.getElementById("tradeNote")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
      const tgtNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
      check("UI set graduation target (dev control) works", /Target updated ✓/.test(tgtNote), tgtNote.trim().slice(0, 60));
      await page.click("#collectBtn");
      await page.waitForFunction(() => /Collected ✓|failed|error/i.test(document.getElementById("tradeNote")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
      const colNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
      check("UI collect creator fees (withdrawDev) works", /Collected ✓/.test(colNote), `sellFee escrow=${(+ethers.formatEther(escBefore)).toFixed(5)} ETH · ${colNote.trim().slice(0, 40)}`);
      await page.click("#burnBtn");
      await page.waitForFunction(() => /Burned ✓|failed|error/i.test(document.getElementById("tradeNote")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
      const burnNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
      check("UI buy & burn (burnDev) works", /Burned ✓/.test(burnNote), burnNote.trim().slice(0, 50));
    } else {
      check("creator controls (dev panel) available", false, "dev panel never became visible");
    }

    // (2) setup: aim graduation at the earliest tick, then climb (direct router buys) until ready
    const minTick = await curve.minGradTick();
    await (await curve.setGradTarget(minTick)).wait();
    let climbs = 0;
    while (!(await curve.ready()) && climbs < 40) {
      await (await router.buy(token, 0n, { value: ethers.parseEther("0.5"), gasLimit: 5_000_000n })).wait();
      climbs++;
    }
    const ready = await curve.ready();
    check("curve reaches the graduation window", ready, `ready=${ready} after ${climbs} climb-buys (~${(climbs * 0.5).toFixed(1)} ETH)`);

    // (3) prove the GRADUATE button — reload so the UI shows it, then click it (this graduation tx must also
    //     fit the 2^24 per-tx cap — it's the heaviest post-launch call, deploying the Bond).
    await page.goto(`${WEB_URL}/token.html?c=${token}`, { waitUntil: "domcontentloaded" });
    await page.click("#connectBtn").catch(() => {});
    const gradShown = await page.waitForFunction(() => {
      const b = document.getElementById("gradBtn"); return b && getComputedStyle(b).display !== "none";
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    check("UI shows the Graduate button when ready", gradShown, gradShown ? "gradBtn visible" : "never appeared");
    if (gradShown) {
      await page.click("#gradBtn");
      await page.waitForFunction(() => {
        const t = document.getElementById("tradeNote")?.textContent || "";
        return /Graduated ✓/.test(t) || /(failed|Not enough|Couldn|revert|cancelled)/i.test(t);
      }, null, { timeout: 90000 }).catch(() => {});
      const gradNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
      check("UI graduate succeeds (Bond posted, under the 2^24 cap)", /Graduated ✓/.test(gradNote),
        `${gradNote.trim().slice(0, 90)} · ${quirks.capRejected} tx(s) rejected by cap`);
    }

    // (4) verify on-chain: graduated + a real Bond address
    const [graduated, bond] = await Promise.all([curve.graduated(), curve.bond()]);
    const bondOk = graduated && /^0x[0-9a-fA-F]{40}$/.test(bond) && !/^0x0+$/.test(bond);
    check("coin graduated on-chain with a live Bond", bondOk, `graduated=${graduated} bond=${bond}`);

    // (5) the UI reflects graduation
    const stageShown = await page.waitForFunction(() => /Graduated/i.test(document.getElementById("stStage")?.textContent || ""), null, { timeout: 15000 }).then(() => true).catch(() => false);
    await page.screenshot({ path: path.join(SHOTS, "token-graduated.png"), fullPage: true }).catch(() => {});
    check("token page shows the Graduated stage", stageShown, stageShown ? "stage = Graduated, Bond live" : "stage never flipped");

    // ============ POST-GRADUATION FEATURES: LP vault · rewards · admin ============

    // (6) THE LP VAULT ("lock liquidity") — deposit, claim, withdraw. The deposit's manipulation guard needs a
    //     warm TWAP: prime it with two small swaps spaced in time, then let the price settle so spot ≈ TWAP.
    try {
      await (await router.buy(token, 0n, { value: ethers.parseEther("0.05"), gasLimit: 5_000_000n })).wait();
      await node2.send("evm_increaseTime", [45]); await node2.send("evm_mine", []);
      await (await router.buy(token, 0n, { value: ethers.parseEther("0.05"), gasLimit: 5_000_000n })).wait();
      await node2.send("evm_increaseTime", [400]); await node2.send("evm_mine", []);
    } catch (e) { log("floor TWAP warmup:", e.message); }
    await page.goto(`${WEB_URL}/token.html?c=${token}`, { waitUntil: "domcontentloaded" });
    await page.click("#connectBtn").catch(() => {});
    await page.waitForFunction(() => /0x[0-9a-fA-F]{4}…/.test(document.getElementById("connectBtn")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
    const coopContract = (a) => new ethers.Contract(a, ["function shares(address) view returns (uint256)"], node2);
    const floorFacC = new ethers.Contract(addrs.floorCoopFactory, ["function coopOf(address) view returns (address)"], node2);
    await page.fill("#fcInput", "0.1");
    await page.click("#fcAdd");
    await page.waitForFunction(() => /locked ✓|failed|Not enough|Couldn|revert|Manipulated|Stale|cancelled/i.test(document.getElementById("tradeNote")?.textContent || ""), null, { timeout: 60000 }).catch(() => {});
    const lockNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
    let coopAddr = await floorFacC.coopOf(token);
    let mineShares = (coopAddr && !/^0x0+$/.test(coopAddr)) ? await coopContract(coopAddr).shares(ACCT) : 0n;
    check("UI lock liquidity (FloorCoop deposit) works", /locked ✓/i.test(lockNote) && mineShares > 0n, `${lockNote.trim().slice(0, 50)} · shares=${mineShares}`);

    // prove the LP provider actually EARNS fees: generate real trading volume with balanced round-trips (buy,
    // then sell exactly what was bought → price returns, fees accrue), settle, compound (keeper), then pending > 0.
    let earnedWeth = 0n, earnedTok = 0n;
    if (coopAddr && !/^0x0+$/.test(coopAddr)) {
      const tok = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], owner);
      for (let i = 0; i < 8; i++) {
        const b0 = await tok.balanceOf(ACCT);
        await (await router.buy(token, 0n, { value: ethers.parseEther("0.3"), gasLimit: 5_000_000n })).wait();
        const got = (await tok.balanceOf(ACCT)) - b0;
        await (await tok.approve(addrs.padRouter, got)).wait();
        await (await router.sell(token, got, 0n, { gasLimit: 5_000_000n })).wait();
      }
      await node2.send("evm_increaseTime", [400]); await node2.send("evm_mine", []);
      const coopKeeper = new ethers.Contract(coopAddr, ["function compound()", "function pending(address) view returns (uint256 wethOwed, uint256 tokenOwed)"], owner);
      try { await (await coopKeeper.compound()).wait(); } catch (e) { log("floor compound:", e.message); }
      const pend = await coopKeeper.pending(ACCT); earnedWeth = pend[0]; earnedTok = pend[1];
    }
    check("LP provider earns fees from trading volume", earnedWeth > 0n || earnedTok > 0n,
      `pending ${(+ethers.formatEther(earnedWeth)).toFixed(5)} ETH + ${Math.round(+ethers.formatUnits(earnedTok, 18))} tokens`);

    // reload so the page reads the settled pool, reconnect, then CLAIM those fees through the UI
    await page.goto(`${WEB_URL}/token.html?c=${token}`, { waitUntil: "domcontentloaded" });
    await page.click("#connectBtn").catch(() => {});
    await page.waitForFunction(() => /0x[0-9a-fA-F]{4}…/.test(document.getElementById("connectBtn")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
    await page.click("#fcClaim");
    await page.waitForFunction(() => /Claimed ✓|failed|error|revert/i.test(document.getElementById("tradeNote")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
    const fcClaimNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
    const pendAfter = (coopAddr && !/^0x0+$/.test(coopAddr)) ? await new ethers.Contract(coopAddr, ["function pending(address) view returns (uint256,uint256)"], node2).pending(ACCT) : [0n, 0n];
    check("UI claim floor fees pays out the earned fees", /Claimed ✓/i.test(fcClaimNote) && pendAfter[0] < earnedWeth, `claimed; pending ETH ${(+ethers.formatEther(earnedWeth)).toFixed(5)} → ${(+ethers.formatEther(pendAfter[0])).toFixed(5)}`);
    await page.click("#fcWithdraw");
    await page.waitForFunction(() => /Withdrawn ✓|failed|error|revert/i.test(document.getElementById("tradeNote")?.textContent || ""), null, { timeout: 40000 }).catch(() => {});
    const fcWNote = (await page.textContent("#tradeNote").catch(() => "")) || "";
    const sharesAfter = (coopAddr && !/^0x0+$/.test(coopAddr)) ? await coopContract(coopAddr).shares(ACCT) : 0n;
    check("UI withdraw from floor works", /Withdrawn ✓/i.test(fcWNote) && sharesAfter === 0n, `${fcWNote.trim().slice(0, 45)} · sharesAfter=${sharesAfter}`);

    // (7) REWARDS — accrue a 0.25% leg, advance the epoch, the poster posts a root, then CLAIM through the exact
    //     frontend function the Rewards page calls (Pad.claimReward → guardedSend → RewardVault.claim).
    try {
      const rv = new ethers.Contract(addrs.rewardVault, [
        "function currentEpoch() view returns (uint256)", "function EPOCH() view returns (uint256)",
        "function pot(address,uint256) view returns (uint128 traderPot, uint128 holderPot)",
        "function postRoot(uint256 epoch, bytes32 root, bytes32 algoHash, string uri)",
      ], owner);
      const E = Number(await rv.currentEpoch());
      await (await router.buy(token, 0n, { value: ethers.parseEther("0.2"), gasLimit: 5_000_000n })).wait();
      const potE = await rv.pot(token, E);
      const amount = potE.traderPot; // single claimant → the whole trader pot is one leaf
      const EPOCH = Number(await rv.EPOCH());
      await node2.send("evm_setNextBlockTimestamp", [(E + 1) * EPOCH + 5]); await node2.send("evm_mine", []);
      const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint8", "address", "uint256"], [E, token, 0, ACCT, amount]));
      const leaf = ethers.keccak256(inner); // OZ StandardMerkleTree root of a single leaf IS the leaf; proof []
      await (await rv.postRoot(E, leaf, ethers.keccak256(ethers.toUtf8Bytes("RobinLabs-Rewards-v1")), "")).wait();
      const claimHash = await page.evaluate(async (row) => {
        const tx = await window.RobinPad.claimReward(row);
        return (await tx.wait()).hash;
      }, { epoch: E, coin: token, side: 0, amount: amount.toString(), proof: [] });
      check("UI claim reward (RewardVault) works", typeof claimHash === "string" && claimHash.startsWith("0x"),
        `claimed ${(+ethers.formatEther(amount)).toFixed(5)} ETH · tx ${(claimHash || "").slice(0, 12)}…`);
    } catch (e) {
      check("UI claim reward (RewardVault) works", false, (e.message || String(e)).slice(0, 90));
    }

    // (8) ADMIN PANEL — drive the real owner console (admin.html): withdraw the platform's accrued buy-side fees.
    try {
      const routerR = new ethers.Contract(addrs.padRouter, ["function platformEscrow() view returns (uint256)"], node2);
      const peBefore = await routerR.platformEscrow();
      await page.goto(`${WEB_URL}/admin.html`, { waitUntil: "domcontentloaded" });
      await page.click("#connectBtn").catch(() => {});
      await page.waitForFunction(() => (document.getElementById("valPlatformEscrow")?.textContent || "—") !== "—", null, { timeout: 20000 }).catch(() => {});
      await page.click('button[data-act="withdrawPlatform"]');
      await page.waitForFunction(() => /withdrawPlatform ✓|✗/i.test(document.getElementById("toast")?.textContent || ""), null, { timeout: 40000 }).catch(() => {});
      const toastTxt = (await page.textContent("#toast").catch(() => "")) || "";
      const peAfter = await routerR.platformEscrow();
      await page.screenshot({ path: path.join(SHOTS, "admin-panel.png"), fullPage: true }).catch(() => {});
      check("admin panel withdraws platform fees", /withdrawPlatform ✓/i.test(toastTxt) && peBefore > 0n && peAfter === 0n,
        `escrow ${(+ethers.formatEther(peBefore)).toFixed(5)} → ${(+ethers.formatEther(peAfter)).toFixed(5)} · ${toastTxt.trim().slice(0, 35)}`);
    } catch (e) {
      check("admin panel withdraws platform fees", false, (e.message || String(e)).slice(0, 90));
    }
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
