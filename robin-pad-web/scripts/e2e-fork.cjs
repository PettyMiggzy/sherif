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
  await p.getByRole('button', { name: '$25', exact: true }).click(); // the required first buy
  await p.screenshot({ path: `${S}/e2e-1-create.png` });
  const usdgBeforeLaunch = await usdgOf(TRADER);
  await p.getByRole('button', { name: /Launch token/ }).click();
  await p.getByRole('button', { name: /Skip for now/ }).waitFor({ timeout: 120000 });
  const countAfter = await launchCount();
  assert.equal(countAfter, countBefore + 1n, 'launchCount did not go up by one');
  const token = '0x' + (await call(PORTAL, '0x41d6e9d3' + pad32(countAfter - 1n))).slice(-40); // allLaunches(i)
  console.log(`launched ${SYMBOL} at ${token}`);
  const firstBought = word(await call(token, '0x70a08231' + pad32(TRADER)));
  const firstSpent = usdgBeforeLaunch - (await usdgOf(TRADER));
  console.log(`first buy at launch: spent $${Number(firstSpent) / 1e6}, got ${Number(firstBought) / 1e18} ${SYMBOL}`);
  assert.equal(firstSpent, 25_000_000n, 'the launch did not include the $25 first buy');
  assert.ok(firstBought > 0n, 'the first buy returned no tokens');

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
  const bought = word(await call(token, '0x70a08231' + pad32(TRADER))) - firstBought;
  console.log(`bought: spent $${Number(usdg0 - usdg1) / 1e6} USDG, got ${Number(bought) / 1e18} ${SYMBOL}`);
  assert.equal(usdg0 - usdg1, 50_000_000n, 'the buy did not spend exactly $50');
  assert.ok(bought > 0n, 'the buy returned no tokens');
  await trade(p, 'sell', '50%');
  const usdg2 = await usdgOf(TRADER);
  console.log(`sold half: got back $${(Number(usdg2 - usdg1) / 1e6).toFixed(4)} USDG`);
  assert.ok(usdg2 > usdg1, 'the sell returned no USDG');
  await p.screenshot({ path: `${S}/e2e-2-token.png` });

  // ── 2b. A launch and a trade on the house pad (a factory pad, not the main
  // portal), so /admin has to collect from both kinds of pad. Straight
  // transactions, like a bot would send them; the site only lists main-portal launches.
  const v = await import('viem');
  const HOUSE = '0x923c4443fd996c757646A9753D89F57913aBEe71';
  const ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
  const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const sendTx = async (from, to, data) => {
    const hash = await rpc('eth_sendTransaction', [{ from, to, data, gas: '0x' + (5_000_000).toString(16) }]);
    let r = null;
    for (let i = 0; i < 60 && !r; i++) { r = await rpc('eth_getTransactionReceipt', [hash]); if (!r) await new Promise((res) => setTimeout(res, 500)); }
    assert.equal(r.status, '0x1', `tx to ${to} reverted`);
    return r;
  };
  const houseAbi = v.parseAbi([
    'struct CreateLaunchParams { string name; string symbol; uint256 startingMarketCapQuote; uint16 buyTaxBps; uint16 sellTaxBps }',
    'struct FeeAllocation { address[] recipients; uint16[] recipientBps; uint16 buybackBps }',
    'function createLaunch(CreateLaunchParams p, FeeAllocation alloc, uint16 maxOwnerShareBps, uint256 maxLaunchFee) returns (address token, address locker)',
    'function launchCount() view returns (uint256)',
    'function allLaunches(uint256) view returns (address)',
    'function splitterForToken(address) view returns (address)',
  ]);
  await sendTx(TRADER, HOUSE, v.encodeFunctionData({ abi: houseAbi, functionName: 'createLaunch', args: [
    { name: 'House Test', symbol: 'HOUSE', startingMarketCapQuote: 5_000_000_000n, buyTaxBps: 500, sellTaxBps: 500 },
    { recipients: [TRADER], recipientBps: [10_000], buybackBps: 0 }, 0, 0n] }));
  const client = v.createPublicClient({ transport: v.http(FORK) });
  const hCount = await client.readContract({ address: HOUSE, abi: houseAbi, functionName: 'launchCount' });
  const hToken = await client.readContract({ address: HOUSE, abi: houseAbi, functionName: 'allLaunches', args: [hCount - 1n] });
  const hFirst = BigInt(hToken) < BigInt(USDG);
  const hKey = { currency0: hFirst ? hToken : USDG, currency1: hFirst ? USDG : hToken, fee: 10000, tickSpacing: 200, hooks: HOOK };
  const buyIn = 40_000_000n; // $40
  const erc20 = v.parseAbi(['function approve(address,uint256) returns (bool)']);
  const permit2 = v.parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
  await sendTx(TRADER, USDG, v.encodeFunctionData({ abi: erc20, functionName: 'approve', args: [PERMIT2, buyIn] }));
  await sendTx(TRADER, PERMIT2, v.encodeFunctionData({ abi: permit2, functionName: 'approve', args: [USDG, ROUTER, buyIn, Math.floor(Date.now() / 1000) + 3600] }));
  const PK = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
  const swapParams = v.encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', ...PK }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
    [{ poolKey: hKey, zeroForOne: !hFirst, amountIn: buyIn, amountOutMinimum: 1n, minHopPriceX36: 0n, hookData: '0x' }]);
  const two = (a, b) => v.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, b]);
  const v4Input = v.encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [v.encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]), [swapParams, two(USDG, buyIn), two(hToken, 1n)]]);
  const urAbi = v.parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
  await sendTx(TRADER, ROUTER, v.encodeFunctionData({ abi: urAbi, functionName: 'execute', args: ['0x10', [v4Input], BigInt(Math.floor(Date.now() / 1000) + 600)] }));
  const hId = v.keccak256(v.encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [hKey.currency0, hKey.currency1, 10000, 200, HOOK]));
  const hPending = word(await call(HOOK, '0xea940ca0' + hId.slice(2)));
  console.log(`house pad: launched HOUSE, bought $40 through the router, $${Number(hPending) / 1e6} tax waiting in the hook`);
  assert.equal(hPending, 2_000_000n, 'house-pad buy tax is not exactly 5% of $40');
  const hSplitter = await client.readContract({ address: HOUSE, abi: houseAbi, functionName: 'splitterForToken', args: [hToken] });

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
  assert.equal(word(await call(HOOK, '0xea940ca0' + hId.slice(2))), 0n, 'house-pad tax still waiting in the hook');
  assert.equal(word(await call(hSplitter, '0x75cda51c')), 0n, 'house-pad platform credit not claimed'); // platformCredit()
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
