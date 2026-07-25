// ─────────────────────────────────────────────────────────────────────────────
// harvest-fees.mjs — sweep every live coin's LP + swap fees to their configured
// recipients (platform wallet / creator project wallet), in one command.
//
// Run ON THE DROPLET, where RPC + PRIVATE_KEY (launchpad/.env) and the whitelisted
// Alchemy key live. Standalone: needs only `ethers` (already installed here).
//
//   node scripts/harvest-fees.mjs            # DRY RUN — simulates, sends nothing
//   HARVEST=1 node scripts/harvest-fees.mjs  # actually broadcast the collections
//
// What it calls (all permissionless; funds only ever go to the fixed recipients):
//   • collectFees()  on each live curve      → LP fees split creator/platform
//   • withdrawDev()  on the router           → creator sell-escrow → project wallet
//   • claimDeferred()/flushBurn() on graduated coins (platform deferred + burn)
//
// Gas is priced above the chain's MOVING base fee (1.2x) so a tick-up can't
// underprice a collection ("max fee per gas less than block base fee").
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.env.HARVEST !== '1';
const CHAIN_ID = 4663;
const API = (process.env.API_BASE || 'https://api.robinlab.io').replace(/\/+$/, '');
const EXPLORER = 'https://robinhoodchain.blockscout.com/tx/';

// ── env (launchpad/.env: RPC=…, PRIVATE_KEY=…) ───────────────────────────────
function loadEnv() {
  const p = path.resolve(__dir, '..', '.env');
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); // trim: CRLF-safe
    }
  } catch { /* fall back to process.env */ }
  return { ...out, ...process.env };
}

const ABI = {
  curve: ['function collectFees() returns (uint256 wethFees, uint256 tokenFees)', 'function graduated() view returns (bool)'],
  router: [
    'function devEscrow(address) view returns (uint256)',
    'function burnEscrow(address) view returns (uint256)',
    'function deferredEscrow(address) view returns (uint256)',
    'function withdrawDev(address)',
    'function claimDeferred(address)',
    'function flushBurn(address)',
  ],
};

const fE = (w) => Number(ethers.formatEther(w)).toLocaleString('en-US', { maximumFractionDigits: 8 });

// Gas price floored above the moving base fee (see header).
async function safeGasPrice(provider) {
  const fee = await provider.getFeeData();
  let gp = fee.gasPrice ?? 0n;
  try {
    const blk = await provider.getBlock('latest');
    const floor = ((blk?.baseFeePerGas ?? 0n) * 12n) / 10n;
    if (floor > gp) gp = floor;
  } catch { /* keep suggested */ }
  if (gp <= 0n) throw new Error('RPC returned no usable gas price');
  return gp;
}

async function main() {
  const env = loadEnv();
  if (!env.RPC) throw new Error('no RPC in launchpad/.env');
  const provider = new ethers.JsonRpcProvider(env.RPC, { chainId: CHAIN_ID, name: 'robinhood' }, { staticNetwork: true, batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`wrong chain ${net.chainId}, expected ${CHAIN_ID}`);

  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dir, '..', 'deploy.json'), 'utf8'));
  const ROUTER = manifest.contracts.padRouter;

  console.log('─'.repeat(64));
  console.log(`  ${DRY ? 'DRY RUN (simulating, nothing sent)' : 'HARVEST (broadcasting)'}  ·  router ${ROUTER}`);
  console.log('─'.repeat(64));

  let signer = null;
  if (!DRY) {
    if (!env.PRIVATE_KEY) throw new Error('HARVEST=1 but no PRIVATE_KEY in launchpad/.env');
    signer = new ethers.Wallet(env.PRIVATE_KEY, provider);
    const bal = await provider.getBalance(signer.address);
    console.log(`  caller ${signer.address}  balance ${fE(bal)} ETH`);
  }
  const rtRead = new ethers.Contract(ROUTER, ABI.router, provider);

  // Paginate — /api/coins defaults to 60, so fetch every page or the oldest (largest-fee)
  // coins would be silently skipped once the pad passes one page.
  const coins = [];
  for (let offset = 0; ; offset += 200) {
    const r = await (await fetch(`${API}/api/coins?limit=200&offset=${offset}`)).json();
    const page = r.coins || [];
    coins.push(...page);
    if (page.length === 0 || (r.total != null && coins.length >= r.total)) break;
    if (page.length < 200) break;
  }
  console.log(`  ${coins.length} coin(s) on the pad\n`);

  const send = async (contract, method, args, gasLimit, label) => {
    if (DRY) {
      try { await contract[method].staticCall(...args); console.log(`   [dry] ${label}: OK (would send)`); }
      catch (e) { console.log(`   [dry] ${label}: would revert — ${(e.shortMessage || e.message || '').slice(0, 70)}`); }
      return;
    }
    try {
      const gp = await safeGasPrice(provider);
      const tx = await contract.connect(signer)[method](...args, { type: 0, gasPrice: gp, gasLimit });
      const rc = await tx.wait(1, 150000);
      console.log(`   ✓ ${label}: status ${rc.status}  ${EXPLORER}${tx.hash}`);
    } catch (e) { console.log(`   ✗ ${label}: ${(e.shortMessage || e.message || '').slice(0, 90)}`); }
  };

  for (const c of coins) {
    console.log(`$${c.symbol}  ${c.graduated ? '[graduated]' : '[live]'}`);
    const curve = new ethers.Contract(c.curve, ABI.curve, provider);
    // 1) LP fees (pre-graduation only; post-grad the position is already swept)
    if (!c.graduated) await send(curve, 'collectFees', [], 900000n, 'LP collectFees');
    // 2) creator swap escrow → project wallet
    const dev = await rtRead.devEscrow(c.token).catch(() => 0n);
    if (dev > 0n) await send(rtRead, 'withdrawDev', [c.token], 200000n, `withdrawDev (${fE(dev)} ETH)`);
    else console.log('   swap escrow: 0');
    // 3) graduated extras: platform deferred + burn buyback
    if (c.graduated) {
      const def = await rtRead.deferredEscrow(c.token).catch(() => 0n);
      if (def > 0n) await send(rtRead, 'claimDeferred', [c.token], 250000n, `claimDeferred (${fE(def)} ETH)`);
      const brn = await rtRead.burnEscrow(c.token).catch(() => 0n);
      if (brn > 0n) await send(rtRead, 'flushBurn', [c.token], 900000n, `flushBurn (${fE(brn)} ETH)`);
    }
    console.log('');
  }
  console.log('─'.repeat(64));
  console.log(DRY ? '  Dry run done. Re-run with HARVEST=1 to broadcast.' : '  Harvest complete.');
}

main().catch((e) => { console.error('\n✗ ' + (e.message || e)); process.exit(1); });
