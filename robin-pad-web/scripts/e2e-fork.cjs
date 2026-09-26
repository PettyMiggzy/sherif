// Browser E2E of the whole flow against an anvil fork of Robinhood Chain
// mainnet, where Robin Labs Pad is already deployed: launch a token at a
// custom starting market cap, buy it and sell it through the real Universal
// Router, then collect the platform's fees and withdraw them on /admin.
//
// The site must be built with its RPC pointed at the fork, so the server's
// launch list and the browser both read the fork:
//
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547 --chain-id 4663
//   NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8547 npx next build && npx next start -p 3100
//   SITE=http://localhost:3100 node scripts/e2e-fork.cjs
//
// A stand-in injected "MetaMask" sends transactions from impersonated fork
// accounts (the trader, then the treasury owner). It refuses to sign
// messages, so saving a token's picture/description is skipped. Nothing
// touches the real chain. Needs Playwright with a Chromium (PLAYWRIGHT_PATH /
// CHROMIUM_PATH if they aren't on the default paths).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');

const S = process.env.OUT_DIR || '.';
const FORK = process.env.FORK_RPC || 'http://127.0.0.1:8547';
const SITE = process.env.SITE || 'http://localhost:3100';
const PORTAL = '0x7e2f5dEe1A846fF21eE946d2e450F64133d0fD6F';
const HOOK = '0x04abDE4e77036178E0DF13d435B7b7f87265e8cc';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TREASURY = '0x2F59476D23dE13e1Cd171d69Efe1227dE8349D3f';
const OWNER = '0x5899a0576A94327a6316E01190f951edf7645914';
const TRADER = '0x4444444444444444444444444444444444444444';
const MC_USD = Number(process.env.MC_USD || 25_000); // not a preset: typed into the box
const SYMBOL = process.env.SYMBOL || 'SHWD';

async function rpc(method, params = []) {
  const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const word = (hex) => BigInt(hex);
const pad32 = (x) => BigInt(x).toString(16).padStart(64, '0');
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const usdgOf = async (a) => word(await call(USDG, '0x70a08231' + pad32(a)));
const launchCount = async () => word(await call(PORTAL, '0x27cca59f'));

async function fundUsdg(account, raw) {
  // USDG (Paxos) keeps balances in a mapping at storage slot 1.
  const { keccak256 } = await import('viem');
  const slot = keccak256(('0x' + pad32(account) + pad32(1)));
  await rpc('anvil_setStorageAt', [USDG, slot, '0x' + pad32(raw)]);
}

const walletScript = `(() => {
  let n = 0;
  const listeners = {};
  const account = () => localStorage.getItem('e2e-account');
  async function forward(method, params) {
    const r = await fetch('https://mock-wallet.invalid/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  }
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      (window.__walletCalls = window.__walletCalls || []).push(method);
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [account()];
        case 'eth_chainId': return '0x1237';
        case 'net_version': return '4663';
        case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': case 'wallet_watchAsset': case 'wallet_revokePermissions': return null;
        case 'wallet_requestPermissions': case 'wallet_getPermissions': return [{ parentCapability: 'eth_accounts' }];
        case 'personal_sign': case 'eth_signTypedData_v4': { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
        default: return forward(method, params);
      }
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return provider; },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
  };
  provider.off = provider.removeListener;
  window.ethereum = provider;
  const info = { uuid: '0b8f0d2e-6d5a-4f7e-9d0e-7a1c2b3d4e5f', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', rdns: 'io.metamask' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

async function connect(p, account) {
  await p.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  const connected = p.getByRole('button', { name: new RegExp(account.slice(0, 6), 'i') }).first();
  if (await connected.isVisible().catch(() => false)) return;
  await p.getByRole('button', { name: 'Connect Wallet' }).first().click();
  const dialog = p.getByRole('dialog');
  await dialog.waitFor({ timeout: 20000 });
  await dialog.getByText('MetaMask', { exact: true }).first().click();
  await connected.waitFor({ timeout: 30000 });
}

async function trade(p, side, amountText) {
  await p.getByRole('button', { name: side === 'buy' ? 'Buy' : 'Sell', exact: true }).click();
  if (side === 'buy') await p.getByPlaceholder('0.0').fill(amountText);
  else await p.getByRole('button', { name: amountText, exact: true }).click(); // e.g. "50%"
  const go = p.getByRole('button', { name: new RegExp(`^${side === 'buy' ? 'Buy' : 'Sell'} ${SYMBOL}$`) });
  await go.waitFor({ timeout: 30000 });
  await p.waitForFunction((sel) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === sel); return b && !b.disabled; }, `${side === 'buy' ? 'Buy' : 'Sell'} ${SYMBOL}`, { timeout: 30000 });
  await go.click();
  // The panel clears the amount once the swap is mined.
  await p.waitForFunction(() => document.querySelector('input[placeholder="0.0"]')?.value === '', null, { timeout: 90000 });
}

(async () => {
  for (const a of [TRADER, OWNER]) {
    await rpc('anvil_setBalance', [a, '0x' + (10n ** 18n).toString(16)]);
    await rpc('anvil_impersonateAccount', [a]);
  }
  await fundUsdg(TRADER, 1_000_000_000n); // $1,000
  const countBefore = await launchCount();

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await ctx.route(/mock-wallet\.invalid/, async (route) => {
    const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: await r.text() });
  });
  // Nothing but the site and the fork: no explorer pings, no third-party calls.
  await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|mock-wallet\.invalid)/, (route) => route.abort());
  await ctx.addInitScript(walletScript);
  const p = await ctx.newPage();
  globalThis.__page = p;
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(SITE, { waitUntil: 'domcontentloaded' });
  await p.evaluate((a) => localStorage.setItem('e2e-account', a), TRADER);

  // ── 1. Launch at a custom starting market cap ──────────────────────────────
  await p.goto(`${SITE}/create`, { waitUntil: 'domcontentloaded' });
  await connect(p, TRADER);
  await p.getByPlaceholder('Sherwood Coin', { exact: true }).fill('Sherwood Test');
  await p.getByPlaceholder('SHWD', { exact: true }).fill(SYMBOL);
  await p.locator('input[type="number"]').first().fill(String(MC_USD));
  await p.screenshot({ path: `${S}/e2e-1-create.png` });
  await p.getByRole('button', { name: /Launch token/ }).click();
  await p.getByRole('button', { name: /Skip for now/ }).waitFor({ timeout: 90000 });
  const countAfter = await launchCount();
  assert.equal(countAfter, countBefore + 1n, 'launchCount did not go up by one');
  const token = '0x' + (await call(PORTAL, '0x41d6e9d3' + pad32(countAfter - 1n))).slice(-40); // allLaunches(i)
  console.log(`launched ${SYMBOL} at ${token}`);

  // Opening market cap from the pool itself: price x 1B supply, in USDG.
  const { keccak256, encodeAbiParameters } = await import('viem');
  const tokenFirst = BigInt(token) < BigInt(USDG);
  const key = [tokenFirst ? token : USDG, tokenFirst ? USDG : token, 10000, 200, HOOK];
  const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], key));
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
  const slot0 = word(await rpc('eth_call', [{ to: '0x8366a39CC670B4001A1121B8F6A443A643e40951', data: '0x1e2eaeaf' + slot.slice(2) }, 'latest']));
  const sp = Number(slot0 & ((1n << 160n) - 1n)) / 2 ** 96;
  const raw1per0 = sp * sp;
  const priceUsd = tokenFirst ? raw1per0 * 1e12 : (1 / raw1per0) * 1e12;
  const openMc = priceUsd * 1e9;
  console.log(`opening market cap on-chain: $${openMc.toFixed(2)} (asked for $${MC_USD})`);
  assert.ok(Math.abs(openMc - MC_USD) / MC_USD < 0.02, 'opening market cap is not what the creator picked');

  // ── 2. Buy and sell through the real Universal Router ─────────────────────
  await p.goto(`${SITE}/token/${token}`, { waitUntil: 'domcontentloaded' });
  await connect(p, TRADER);
  const usdg0 = await usdgOf(TRADER);
  await trade(p, 'buy', '50');
  const usdg1 = await usdgOf(TRADER);
  const bought = word(await call(token, '0x70a08231' + pad32(TRADER)));
  console.log(`bought: spent $${Number(usdg0 - usdg1) / 1e6} USDG, got ${Number(bought) / 1e18} ${SYMBOL}`);
  assert.equal(usdg0 - usdg1, 50_000_000n, 'the buy did not spend exactly $50');
  assert.ok(bought > 0n, 'the buy returned no tokens');
  await trade(p, 'sell', '50%');
  const usdg2 = await usdgOf(TRADER);
  console.log(`sold half: got back $${(Number(usdg2 - usdg1) / 1e6).toFixed(4)} USDG`);
  assert.ok(usdg2 > usdg1, 'the sell returned no USDG');
  await p.screenshot({ path: `${S}/e2e-2-token.png` });

  // ── 3. Collect and withdraw as the treasury owner ─────────────────────────
  await p.evaluate((a) => localStorage.setItem('e2e-account', a), OWNER);
  await p.goto(`${SITE}/admin`, { waitUntil: 'domcontentloaded' });
  await p.context().clearCookies(); // drop the trader's wagmi session
  await p.reload({ waitUntil: 'domcontentloaded' });
  await connect(p, OWNER);
  const ownerBefore = await usdgOf(OWNER);
  const treasuryBefore = await usdgOf(TREASURY);
  await p.getByRole('button', { name: /Collect & withdraw everything/ }).click();
  await p.getByText(/Withdrew \$|holds no USDG|Only the treasury owner/).first().waitFor({ timeout: 120000 });
  const got = (await usdgOf(OWNER)) - ownerBefore;
  console.log(`owner withdrew $${(Number(got) / 1e6).toFixed(6)} (treasury held $${Number(treasuryBefore) / 1e6} before collecting)`);
  assert.ok(got > 0n, 'nothing was withdrawn');
  assert.equal(await usdgOf(TREASURY), 0n, 'treasury not emptied');
  assert.equal(word(await call(HOOK, '0xea940ca0' + id.slice(2))), 0n, 'tax still waiting in the hook'); // pendingTax(id)
  await p.screenshot({ path: `${S}/e2e-3-admin.png`, fullPage: true });

  // React's hydration warnings (#418/#423/#425: server and browser rendered a
  // different string, e.g. a relative time) are recovered from on the spot;
  // anything else is a real crash.
  const hydration = errs.filter((m) => /Minified React error #4(18|23|25)/.test(m));
  const real = errs.filter((m) => !hydration.includes(m));
  console.log(`page errors: ${real.length ? real.join(' | ') : 'none'} (hydration warnings: ${hydration.length})`);
  assert.equal(real.length, 0, 'the page threw');
  console.log('E2E PASSED');
  await browser.close();
})().catch(async (e) => {
  console.error('E2E FAILED:', e.message);
  if (globalThis.__page) await globalThis.__page.screenshot({ path: `${S}/e2e-failed.png`, fullPage: true }).catch(() => {});
  process.exit(1);
});
