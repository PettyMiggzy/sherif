/*
 * Browser check for the WalletConnect wiring. Run it:  node pad/e2e/walletconnect.mjs
 *
 * This exists because the WalletConnect path cannot be exercised by the contract suites and cannot be fully
 * exercised without a phone — but almost everything that can actually break here breaks BEFORE a phone is
 * involved: a missing export, an icon the picker refuses to render, the 2MB bundle being pulled on every page
 * load, the extension case hiding the QR option. It already caught one: the miner's `mineSaltAsync` was not
 * exported at all, and nothing else in the repo imported it, so the launch page would have died at its first
 * mine with a module error.
 *
 * What a phone is still needed for: approving a real session, and whether a given wallet accepts chain 4663.
 *
 * Uses the Chromium that ships with this environment. Everything off-origin is blocked so the run measures
 * the module graph rather than the live API.
 */
// Playwright is a devDependency of launchpad/, and pad/ has no node_modules of its own — it is a static
// site. Resolve it from wherever it actually is rather than adding a package.json here just to hold one dev
// dependency for one script.
const { chromium } = await (async () => {
  for (const spec of ["playwright", "../../launchpad/node_modules/playwright/index.mjs"]) {
    try { return await import(spec); } catch { /* try the next */ }
  }
  throw new Error("playwright not found — run `npm install` in launchpad/, or set NODE_PATH");
})();
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const f = path.join(ROOT, u === "/" ? "/index.html" : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined });
const onlyLocal = (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort());
const results = [];
const check = (name, fn) => { try { fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name + " — " + e.message]); } };

async function openPicker(page) {
  await page.evaluate(async (b) => { const w = await import(b + "/assets/wallet.js"); w.connect().catch(() => {}); }, base);
  await page.waitForSelector("#rl-wallet-modal", { timeout: 8000 });
  return page.evaluate(() => {
    const m = document.getElementById("rl-wallet-modal");
    return {
      buttons: [...m.querySelectorAll("[data-i]")].map((b) => b.textContent.trim()),
      subtitle: m.querySelector("div > div:nth-child(2)")?.textContent.trim() || "",
      hasDeepLink: !!m.querySelector("#rl-wallet-deeplink"),
    };
  });
}

// ── 1. the module graph, with nothing installed ──────────────────────────────
const page = await browser.newPage();
const fatal = [];
page.on("pageerror", (e) => fatal.push(e.message));
await page.route("**/*", onlyLocal);
let vendorHits = 0;
page.on("request", (r) => { if (r.url().includes("walletconnect-provider")) vendorHits++; });
await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);

const mod = await page.evaluate(async (b) => {
  const wc = await import(b + "/assets/walletconnect.js");
  const cfg = await import(b + "/assets/config.js");
  const mine = await import(b + "/assets/robin-mine.mjs");
  const e = wc.wcWalletEntry();
  return {
    projectId: cfg.WALLETCONNECT_PROJECT_ID, name: e.info.name, rdns: e.info.rdns,
    // the picker's safeIcon() rejects remote/unsafe icons and anything with quotes, spaces or angle brackets
    iconOk: /^data:image\//.test(e.info.icon) && !/["'<>\s]/.test(e.info.icon),
    lazyIsFn: typeof e.lazy === "function", providerNull: e.provider === null,
    mineExports: Object.keys(mine).sort(),
  };
}, base);

check("project id is configured", () => assert.match(mod.projectId, /^[0-9a-f]{32}$/));
check("the picker entry is a WalletConnect wallet", () => { assert.equal(mod.name, "WalletConnect"); assert.equal(mod.rdns, "walletconnect"); });
check("its icon is one the picker will actually render", () => assert.equal(mod.iconOk, true));
check("its provider is lazy, not built at import", () => { assert.equal(mod.lazyIsFn, true); assert.equal(mod.providerNull, true); });
check("the miner exports everything the launch page imports", () =>
  assert.deepEqual(mod.mineExports, ["SUFFIX", "isBranded", "mineSalt", "mineSaltAsync", "predict"]));
check("no page errors on load", () => assert.deepEqual(fatal, []));

const p1 = await openPicker(page);
check("with nothing installed, WalletConnect is offered", () => assert.deepEqual(p1.buttons, ["WalletConnect"]));
check("the desktop copy does not promise a deep link", () => assert.equal(p1.hasDeepLink, false));
check("the 2MB bundle is NOT fetched before it is chosen", () => assert.equal(vendorHits, 0));

const vendor = await page.evaluate(async (b) => {
  const v = await import(b + "/assets/vendor/walletconnect-provider.mjs");
  return { hasInit: typeof v.EthereumProvider?.init === "function" };
}, base);
check("the vendored bundle exposes EthereumProvider.init", () => assert.equal(vendor.hasInit, true));
await page.close();

// ── 2. an installed extension must not hide the QR option ────────────────────
{
  const p = await browser.newPage();
  await p.route("**/*", onlyLocal);
  await p.addInitScript(() => {
    const fake = { request: async ({ method }) => (method === "eth_chainId" ? "0x1237" : []), on() {}, removeAllListeners() {} };
    addEventListener("eip6963:requestProvider", () => dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid: "u", name: "MetaMask", rdns: "io.metamask", icon: "" }, provider: fake } })));
  });
  await p.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const r = await openPicker(p);
  // This is the regression that matters most: the picker used to auto-connect when exactly one wallet was
  // present, which with an extension installed would make WalletConnect unreachable forever.
  check("one extension installed still offers BOTH", () => assert.deepEqual(r.buttons, ["MetaMask", "WalletConnect"]));
  await p.close();
}

// ── 3. mobile keeps the older deep-link route ────────────────────────────────
{
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const p = await ctx.newPage();
  await p.route("**/*", onlyLocal);
  await p.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  const r = await openPicker(p);
  check("mobile offers WalletConnect", () => assert.ok(r.buttons.includes("WalletConnect")));
  // Reopening inside the wallet's own browser is still the smoother route when the wallet is on that device,
  // so adding WalletConnect must not have removed it.
  check("mobile still offers 'open in my wallet app'", () => assert.equal(r.hasDeepLink, true));
  await ctx.close();
}

await browser.close();
server.close();

for (const [s, n] of results) console.log(`  ${s === "PASS" ? "✔" : "✘"} ${n}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n  ${results.length - failed} passing${failed ? `, ${failed} failing` : ""}`);
process.exit(failed ? 1 : 0);
