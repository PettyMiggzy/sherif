// Browser E2E of the whole flow against an anvil fork of Elysium: launch a
// token at a custom starting market cap (with its first buy), buy and sell it
// through PadRouter, buy the LP-fee tokens off the fee desk at 10% off, then
// collect the platform's fees and withdraw them on /admin.
//
// The site must be built with its RPC pointed at the fork, so the server's
// launch list and the browser both read the fork. With the stack deployed on
// the fork (usdg-pad/script/DeployElysium.s.sol, ADMIN = OWNER below; on a
// fresh deployer it lands at lib/config.ts's addresses), point the build at it:
//
//   anvil --fork-url https://testnet-rpc.elysium.kinetiq.xyz --port 8549 --chain-id 99801
//   NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8549 npx next build   (+ NEXT_PUBLIC_PORTAL=… etc. if they differ)
//   (same env) npx next start -p 3100
//   SITE=http://localhost:3100 FORK_RPC=http://127.0.0.1:8549 node scripts/e2e-fork.cjs
//
// A stand-in injected "MetaMask" sends transactions from impersonated fork
// accounts (the trader, then the treasury owner). It refuses to sign
// messages, so saving a token's picture/description is skipped. Nothing
// touches the real chain. Needs Playwright with a Chromium (PLAYWRIGHT_PATH /
// CHROMIUM_PATH if they aren't on the default paths).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');

const S = process.env.OUT_DIR || '.';
const FORK = process.env.FORK_RPC || 'http://127.0.0.1:8549';
const SITE = process.env.SITE || 'http://localhost:3100';
const CHAIN_ID = Number(process.env.CHAIN_ID || 99801);
const PORTAL = process.env.PORTAL || '0x788A959628C49b7eB92e6FCe9154dF775B4d709c';
const HOOK = process.env.HOOK || '0x4eB7CD0299021045A92B67a8EE48DE8aA4CA68Cc';
const FEE_DESK = process.env.FEE_DESK ?? '0xBfBBa2Db88caf8ae43Db5f066F340229967965e9'; // '' for a portal without one
const HOUSE_PAD = process.env.HOUSE || '0x5A56339E8a6b5a5001616d6cc2aF55214aaD4760';
const POOL_MANAGER = process.env.POOL_MANAGER || '0xD1a514C574E60aAfCBf9fd822eF64fe963D3B4FA';
const ROUTER = process.env.ROUTER || '0x4ff52c870735200162A971396a6E599536E67254';
// A coin from an older portal, which the site keeps listing and trading (none on Elysium yet).
const LEGACY_TOKEN = process.env.LEGACY_TOKEN || '';
const LEGACY_HOOK = process.env.LEGACY_HOOK || '';
const USDC = process.env.USDC || '0x7D29d8047B905000459c0E80c34a26CeedcB47b2';
const TREASURY = process.env.TREASURY || '0x256772d87147C91749646F8365A2D760336F9E92';
const OWNER = process.env.OWNER || '0x5899a0576A94327a6316E01190f951edf7645914';
const TRADER = '0x4444444444444444444444444444444444444444';
const MC_USD = Number(process.env.MC_USD || 25_000); // not a preset: typed into the box
const SYMBOL = process.env.SYMBOL || 'LAUREL';

async function rpc(method, params = []) {
  const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const word = (hex) => BigInt(hex);
const pad32 = (x) => BigInt(x).toString(16).padStart(64, '0');
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const usdcOf = async (a) => word(await call(USDC, '0x70a08231' + pad32(a)));
const launchCount = async () => word(await call(PORTAL, '0x27cca59f'));

// Sets an ERC-20 balance on the fork by writing the balances mapping. The
// slot differs by token (the bridged USDC is an upgradeable OpenZeppelin
// ERC-20), so it's found once by probing: write a marker, see balanceOf move.
let balanceSlot = null;
async function fundUsdc(account, raw) {
  const { keccak256 } = await import('viem');
  const at = (who, slot) => keccak256('0x' + pad32(who) + pad32(slot));
  if (balanceSlot === null) {
    const probe = '0x00000000000000000000000000000000000e2e01';
    for (let slot = 0; slot < 200 && balanceSlot === null; slot++) {
      const before = await rpc('eth_getStorageAt', [USDC, at(probe, slot), 'latest']);
      await rpc('anvil_setStorageAt', [USDC, at(probe, slot), '0x' + pad32(123456789n)]);
      if ((await usdcOf(probe)) === 123456789n) balanceSlot = slot;
      await rpc('anvil_setStorageAt', [USDC, at(probe, slot), '0x' + pad32(before)]);
    }
    assert.notEqual(balanceSlot, null, 'could not find the USDC balances slot');
  }
  await rpc('anvil_setStorageAt', [USDC, at(account, balanceSlot), '0x' + pad32(raw)]);
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
        case 'eth_chainId': return '${'0x' + CHAIN_ID.toString(16)}';
        case 'net_version': return '${CHAIN_ID}';
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
  await fundUsdc(TRADER, 1_000_000_000n); // $1,000
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
  await p.getByPlaceholder('Laurel Coin', { exact: true }).fill('Laurel Test');
  await p.getByPlaceholder('LAUREL', { exact: true }).fill(SYMBOL);
  await p.locator('input[type="number"]').first().fill(String(MC_USD));
  await p.getByRole('button', { name: '$25', exact: true }).click(); // the required first buy
  await p.screenshot({ path: `${S}/e2e-1-create.png` });
  const usdcBeforeLaunch = await usdcOf(TRADER);
  await p.getByRole('button', { name: /Launch token/ }).click();
  await p.getByRole('button', { name: /Skip for now/ }).waitFor({ timeout: 120000 });
  const countAfter = await launchCount();
  assert.equal(countAfter, countBefore + 1n, 'launchCount did not go up by one');
  const token = '0x' + (await call(PORTAL, '0x41d6e9d3' + pad32(countAfter - 1n))).slice(-40); // allLaunches(i)
  console.log(`launched ${SYMBOL} at ${token}`);
  const firstBought = word(await call(token, '0x70a08231' + pad32(TRADER)));
  const firstSpent = usdcBeforeLaunch - (await usdcOf(TRADER));
  console.log(`first buy at launch: spent $${Number(firstSpent) / 1e6}, got ${Number(firstBought) / 1e18} ${SYMBOL}`);
  assert.equal(firstSpent, 25_000_000n, 'the launch did not include the $25 first buy');
  assert.ok(firstBought > 0n, 'the first buy returned no tokens');

  // Opening market cap from the pool itself: price x 1B supply, in USDC.
  const { keccak256, encodeAbiParameters } = await import('viem');
  const tokenFirst = BigInt(token) < BigInt(USDC);
  const key = [tokenFirst ? token : USDC, tokenFirst ? USDC : token, 10000, 200, HOOK];
  const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], key));
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
  const slot0 = word(await rpc('eth_call', [{ to: POOL_MANAGER, data: '0x1e2eaeaf' + slot.slice(2) }, 'latest']));
  const sp = Number(slot0 & ((1n << 160n) - 1n)) / 2 ** 96;
  const raw1per0 = sp * sp;
  const priceUsd = tokenFirst ? raw1per0 * 1e12 : (1 / raw1per0) * 1e12;
  const openMc = priceUsd * 1e9;
  console.log(`opening market cap on-chain: $${openMc.toFixed(2)} (asked for $${MC_USD})`);
  assert.ok(Math.abs(openMc - MC_USD) / MC_USD < 0.02, 'opening market cap is not what the creator picked');

  // ── 2. Buy and sell through PadRouter ──────────────────────────────────────
  await p.goto(`${SITE}/token/${token}`, { waitUntil: 'domcontentloaded' });
  await connect(p, TRADER);
  const usdc0 = await usdcOf(TRADER);
  await trade(p, 'buy', '50');
  const usdc1 = await usdcOf(TRADER);
  const bought = word(await call(token, '0x70a08231' + pad32(TRADER))) - firstBought;
  console.log(`bought: spent $${Number(usdc0 - usdc1) / 1e6} USDC, got ${Number(bought) / 1e18} ${SYMBOL}`);
  assert.equal(usdc0 - usdc1, 50_000_000n, 'the buy did not spend exactly $50');
  assert.ok(bought > 0n, 'the buy returned no tokens');
  await trade(p, 'sell', '50%');
  const usdc2 = await usdcOf(TRADER);
  console.log(`sold half: got back $${(Number(usdc2 - usdc1) / 1e6).toFixed(4)} USDC`);
  assert.ok(usdc2 > usdc1, 'the sell returned no USDC');
  await p.screenshot({ path: `${S}/e2e-2-token.png` });
  const v = await import('viem');
  const client = v.createPublicClient({ transport: v.http(FORK) });

  // ── 2a. The fee desk: the sell paid its 1% LP fee in the token; collect it
  // onto the desk and buy it all at 10% under the pool price. ─────────────────
  if (FEE_DESK) {
    const deskAbi = v.parseAbi(['function inventory(address) view returns (uint256)', 'function quoteAll(address) view returns (uint256 tokens, uint256 quoteCost)']);
    const inv = () => client.readContract({ address: FEE_DESK, abi: deskAbi, functionName: 'inventory', args: [token] });
    assert.equal(await inv(), 0n, 'the desk should start empty');
    // Two separate swaps: the token page has the market swap only, plus a link
    // to this coin's discount swap on /deals once there are fees for it.
    assert.ok(await p.getByRole('heading', { name: 'Swap', exact: true }).isVisible(), 'no market swap heading');
    assert.equal(await p.getByText(/^Discount swap:/).count(), 0, 'the discount swap should not be on the token page');
    const toDeals = p.getByRole('link', { name: /under market/ });
    await toDeals.waitFor({ timeout: 60000 });
    await toDeals.click();
    await p.waitForURL(/\/deals\?token=/);
    await connect(p, TRADER);
    await p.getByText(`Discount swap: ${SYMBOL}`).waitFor({ timeout: 60000 });
    const t0 = await usdcOf(TREASURY);
    await p.getByRole('button', { name: 'Bring in new fees to buy' }).click();
    await p.getByRole('button', { name: 'All', exact: true }).waitFor({ timeout: 90000 });
    const stocked = await inv();
    const lpUsdc = (await usdcOf(TREASURY)) - t0;
    console.log(`discount swap: stocked with ${Number(stocked) / 1e18} ${SYMBOL}; USDC-side LP fees to the treasury: $${Number(lpUsdc) / 1e6}`);
    assert.ok(stocked > 0n, 'harvest put no tokens on the desk');
    assert.ok(lpUsdc > 0n, 'harvest paid the treasury no USDC');
    const [, cost] = await client.readContract({ address: FEE_DESK, abi: deskAbi, functionName: 'quoteAll', args: [token] });
    // The coin is listed on the left with its price.
    const row = p.locator(`button[data-token]`, { hasText: SYMBOL });
    await p.waitForFunction((sym) => [...document.querySelectorAll('button[data-token]')].some((b) => b.textContent.includes(sym) && /Yours for/.test(b.textContent)), SYMBOL, { timeout: 60000 });
    assert.equal(await row.getAttribute('aria-pressed'), 'true', 'the coin is not the one in the discount swap');
    await p.getByRole('button', { name: 'All', exact: true }).click();
    const deskBuy = p.getByRole('button', { name: new RegExp(`^Buy [\\d.,]+[KMB]? ${SYMBOL}$`) });
    await deskBuy.waitFor({ timeout: 30000 });
    await p.screenshot({ path: `${S}/e2e-2a-deals.png` });
    const tokBefore = word(await call(token, '0x70a08231' + pad32(TRADER)));
    const usdcBefore = await usdcOf(TRADER);
    const tBefore = await usdcOf(TREASURY);
    await deskBuy.click();
    await p.getByText('Nothing for sale yet. The next sells will stock it.').waitFor({ timeout: 90000 });
    const gotTok = word(await call(token, '0x70a08231' + pad32(TRADER))) - tokBefore;
    const paid = usdcBefore - (await usdcOf(TRADER));
    console.log(`fee desk: bought ${Number(gotTok) / 1e18} ${SYMBOL} for $${Number(paid) / 1e6} (desk price for all: $${Number(cost) / 1e6})`);
    assert.equal(gotTok, stocked, 'did not get the whole desk');
    assert.ok(paid > 0n && paid <= cost + 2n, 'paid more than the desk quoted');
    assert.equal((await usdcOf(TREASURY)) - tBefore, paid, 'the desk payment did not go to the treasury');
    assert.equal(await inv(), 0n, 'desk not emptied');
    // 10% off: the tokens are worth ~1/0.9 of what was paid at the pool price.
    const { priceFromSqrt } = { priceFromSqrt: (spx, t0f) => { const x = Number(spx) / 2 ** 96; return t0f ? x * x * 1e12 : (1 / (x * x)) * 1e12; } };
    const s0 = word(await rpc('eth_call', [{ to: POOL_MANAGER, data: '0x1e2eaeaf' + slot.slice(2) }, 'latest']));
    const worth = (Number(gotTok) / 1e18) * priceFromSqrt(s0 & ((1n << 160n) - 1n), tokenFirst);
    const discount = 1 - Number(paid) / 1e6 / worth;
    console.log(`fee desk discount vs the pool price: ${(discount * 100).toFixed(2)}%`);
    assert.ok(Math.abs(discount - 0.1) < 0.002, 'the desk did not sell at 10% off');
  }

  // ── 2d. A coin from the older portal still trades, on its own hook. ──────────
  let legacyId = null;
  if (LEGACY_TOKEN && LEGACY_HOOK) {
    await p.goto(`${SITE}/token/${LEGACY_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await connect(p, TRADER);
    const lFirst = BigInt(LEGACY_TOKEN) < BigInt(USDC);
    legacyId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [lFirst ? LEGACY_TOKEN : USDC, lFirst ? USDC : LEGACY_TOKEN, 10000, 200, LEGACY_HOOK]));
    const lSym = await client.readContract({ address: LEGACY_TOKEN, abi: v.parseAbi(['function symbol() view returns (string)']), functionName: 'symbol' });
    const lBefore = word(await call(LEGACY_TOKEN, '0x70a08231' + pad32(TRADER)));
    await p.getByRole('button', { name: 'Buy', exact: true }).click();
    await p.getByPlaceholder('0.0').fill('5');
    const go = p.getByRole('button', { name: `Buy ${lSym}`, exact: true });
    await p.waitForFunction((sel) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === sel); return b && !b.disabled; }, `Buy ${lSym}`, { timeout: 30000 });
    await go.click();
    await p.waitForFunction(() => document.querySelector('input[placeholder="0.0"]')?.value === '', null, { timeout: 90000 });
    const lGot = word(await call(LEGACY_TOKEN, '0x70a08231' + pad32(TRADER))) - lBefore;
    console.log(`older portal: bought ${Number(lGot) / 1e18} ${lSym} for $5 on its own hook`);
    assert.ok(lGot > 0n, 'the older coin did not trade');
    await p.screenshot({ path: `${S}/e2e-2d-legacy.png` });
  }

  // ── 2b. A launch and a trade on the house pad (a factory pad, not the main
  // portal), so /admin has to collect from both kinds of pad. Straight
  // transactions, like a bot would send them; the site only lists main-portal launches.
  const HOUSE = HOUSE_PAD;
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
  const hCount = await client.readContract({ address: HOUSE, abi: houseAbi, functionName: 'launchCount' });
  const hToken = await client.readContract({ address: HOUSE, abi: houseAbi, functionName: 'allLaunches', args: [hCount - 1n] });
  const hFirst = BigInt(hToken) < BigInt(USDC);
  const hKey = { currency0: hFirst ? hToken : USDC, currency1: hFirst ? USDC : hToken, fee: 10000, tickSpacing: 200, hooks: HOOK };
  const buyIn = 40_000_000n; // $40
  const erc20 = v.parseAbi(['function approve(address,uint256) returns (bool)']);
  const permit2 = v.parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
  await sendTx(TRADER, USDC, v.encodeFunctionData({ abi: erc20, functionName: 'approve', args: [PERMIT2, buyIn] }));
  await sendTx(TRADER, PERMIT2, v.encodeFunctionData({ abi: permit2, functionName: 'approve', args: [USDC, ROUTER, buyIn, Math.floor(Date.now() / 1000) + 3600] }));
  const PK = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
  const swapParams = v.encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', ...PK }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
    [{ poolKey: hKey, zeroForOne: !hFirst, amountIn: buyIn, amountOutMinimum: 1n, minHopPriceX36: 0n, hookData: '0x' }]);
  const two = (a, b) => v.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, b]);
  const v4Input = v.encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [v.encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]), [swapParams, two(USDC, buyIn), two(hToken, 1n)]]);
  const urAbi = v.parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
  await sendTx(TRADER, ROUTER, v.encodeFunctionData({ abi: urAbi, functionName: 'execute', args: ['0x10', [v4Input], BigInt(Math.floor(Date.now() / 1000) + 600)] }));
  const hId = v.keccak256(v.encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [hKey.currency0, hKey.currency1, 10000, 200, HOOK]));
  const hPending = word(await call(HOOK, '0xea940ca0' + hId.slice(2)));
  console.log(`house pad: launched HOUSE, bought $40 through the router, $${Number(hPending) / 1e6} tax waiting in the hook`);
  assert.equal(hPending, 2_000_000n, 'house-pad buy tax is not exactly 5% of $40');
  const hSplitter = await client.readContract({ address: HOUSE, abi: houseAbi, functionName: 'splitterForToken', args: [hToken] });

  // Tax on the new launch so far (first buy, buy, sell), before /admin flushes it.
  const pendingMain = word(await call(HOOK, '0xea940ca0' + id.slice(2)));
  const splitterAbi = v.parseAbi(['function creditedToCreator(address) view returns (uint256)']);
  const mainSplitter = (await client.readContract({ address: PORTAL, abi: v.parseAbi(['function lockerForToken(address) view returns (address)']), functionName: 'lockerForToken', args: [token] }));
  const mainSplitterAddr = await client.readContract({ address: mainSplitter, abi: v.parseAbi(['function splitter() view returns (address)']), functionName: 'splitter' });
  const creatorBefore = await client.readContract({ address: mainSplitterAddr, abi: splitterAbi, functionName: 'creditedToCreator', args: [USDC] });

  // ── 3. Collect and withdraw as the treasury owner ─────────────────────────
  await p.evaluate((a) => localStorage.setItem('e2e-account', a), OWNER);
  await p.goto(`${SITE}/admin`, { waitUntil: 'domcontentloaded' });
  await p.context().clearCookies(); // drop the trader's wagmi session
  await p.reload({ waitUntil: 'domcontentloaded' });
  await connect(p, OWNER);
  const ownerBefore = await usdcOf(OWNER);
  const treasuryBefore = await usdcOf(TREASURY);
  await p.getByRole('button', { name: /Collect & withdraw everything/ }).click();
  await p.getByText(/Withdrew \$|holds no USDC|Only the treasury owner/).first().waitFor({ timeout: 120000 });
  const got = (await usdcOf(OWNER)) - ownerBefore;
  console.log(`owner withdrew $${(Number(got) / 1e6).toFixed(6)} (treasury held $${Number(treasuryBefore) / 1e6} before collecting)`);
  assert.ok(got > 0n, 'nothing was withdrawn');
  assert.equal(await usdcOf(TREASURY), 0n, 'treasury not emptied');
  assert.equal(word(await call(HOOK, '0xea940ca0' + id.slice(2))), 0n, 'tax still waiting in the hook'); // pendingTax(id)
  assert.equal(word(await call(HOOK, '0xea940ca0' + hId.slice(2))), 0n, 'house-pad tax still waiting in the hook');
  assert.equal(word(await call(hSplitter, '0x75cda51c')), 0n, 'house-pad platform credit not claimed'); // platformCredit()
  // The creator's share of that tax, credited when /admin flushed it.
  const creatorPct = BigInt(process.env.CREATOR_PCT || (FEE_DESK ? 80 : 90));
  const creatorGot = (await client.readContract({ address: mainSplitterAddr, abi: splitterAbi, functionName: 'creditedToCreator', args: [USDC] })) - creatorBefore;
  console.log(`tax split: $${Number(pendingMain) / 1e6} flushed, creator credited $${Number(creatorGot) / 1e6} (${creatorPct}%), platform $${Number(pendingMain - creatorGot) / 1e6}`);
  assert.equal(creatorGot, pendingMain - (pendingMain * (100n - creatorPct)) / 100n, `creator did not get exactly ${creatorPct}% of the tax`);
  if (legacyId) assert.equal(word(await call(LEGACY_HOOK, '0xea940ca0' + legacyId.slice(2))), 0n, 'older-portal tax still waiting in its hook');
  // LP fees were collected too: nothing left to harvest on the new launch.
  const lockerOf = v.parseAbi(['function lockerForToken(address) view returns (address)', 'function harvestFees()']);
  const locker = await client.readContract({ address: PORTAL, abi: lockerOf, functionName: 'lockerForToken', args: [token] });
  await assert.rejects(client.simulateContract({ address: locker, abi: lockerOf, functionName: 'harvestFees', account: OWNER }), 'LP fees left unharvested');
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
