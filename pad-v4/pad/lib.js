// ─────────────────────────────────────────────────────────────────────────────
// Robin V4 pad UI — shared library (ES module). Imported by index.html + profile.html.
//
// ethers is loaded LAZILY (dynamic import) so a missing ./ethers.min.js never breaks
// module evaluation — the pages still render full mock data. At deploy, copy ethers v6
// from node_modules/ethers/dist/ethers.min.js next to these files:
//     cp node_modules/ethers/dist/ethers.min.js pad/ethers.min.js
// ─────────────────────────────────────────────────────────────────────────────

import { CHAIN, ADDR, COINS, GRAD } from './config.js';

// ── ethers lazy loader ────────────────────────────────────────────────────────
let _ethers = null;
let _ethersTried = false;
export async function ethersLib() {
  if (_ethers) return _ethers;
  if (_ethersTried) return null;
  _ethersTried = true;
  try {
    const mod = await import('./ethers.min.js');
    _ethers = mod.ethers || mod;
    return _ethers;
  } catch (_) {
    return null; // file absent at build time → UI stays in mock/disabled mode
  }
}

// Read-only provider bound to the chain RPC (for view calls without a wallet).
export async function readProvider() {
  const e = await ethersLib();
  if (!e || !CHAIN.rpc) return null;
  try { return new e.JsonRpcProvider(CHAIN.rpc, CHAIN.id); } catch (_) { return null; }
}

// Injected-wallet provider (for signing txs). Returns null when no wallet present.
export async function walletProvider() {
  const e = await ethersLib();
  if (!e || !globalThis.ethereum) return null;
  try { return new e.BrowserProvider(globalThis.ethereum); } catch (_) { return null; }
}

export async function connectWallet() {
  if (!globalThis.ethereum) throw new Error('No injected wallet found');
  const bp = await walletProvider();
  if (!bp) throw new Error('ethers unavailable');
  await globalThis.ethereum.request({ method: 'eth_requestAccounts' });
  const signer = await bp.getSigner();
  return { provider: bp, signer, address: await signer.getAddress() };
}

// ── ABI fragments — ONLY the views/methods the UI touches ───────────────────────
export const ABI = {
  erc20: [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
  ],
  staking: [
    'function poolInfo() view returns (uint256 staked, uint256 rewardsHeld, uint256 ratePerSec, uint256 finishAt, uint256 parked)',
    'function stakeInfo(address account) view returns (uint256 staked, uint256 claimable, uint256 unlockAt, bool locked)',
    'function earned(address account) view returns (uint256)',
    'function aprBps() view returns (uint256)',
    'function reservoir() view returns (uint256)',
    'function timeUntilUnlock(address account) view returns (uint256)',
    'function totalStaked() view returns (uint256)',
    'function stake(uint256 amount)',
    'function withdraw(uint256 amount)',
    'function getReward()',
    'function exit()',
  ],
  curve: [
    'function token() view returns (address)',
    'function creator() view returns (address)',
    'function staking() view returns (address)',
    'function floor() view returns (address)',
    'function ambush() view returns (address)',
    'function startTick() view returns (int24)',
    'function gradTick() view returns (int24)',
    'function ready() view returns (bool)',
    'function graduated() view returns (bool)',
    'function seeded() view returns (bool)',
  ],
  presale: [
    'function state() view returns (uint8)',            // 0 Open / 1 Launched / 2 Failed
    'function target() view returns (uint256)',
    'function totalRaised() view returns (uint256)',
    'function deadline() view returns (uint64)',
    'function contribution(address) view returns (uint256)',
    'function previewClaim(address user) view returns (uint256 tokenOut, uint256 ethBack)',
    'function claim()',
    'function refund()',
  ],
  stateView: [
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ],
};

export const PRESALE_STATE = { 0: 'Open', 1: 'Launched', 2: 'Failed' };

// ── curve math ──────────────────────────────────────────────────────────────
// Buys walk the tick DOWN from startTick (launch) to gradTick (ceiling). Progress is
// how far the spot tick has travelled toward the ceiling, clamped to [0,1].
export function curveProgress(startTick, gradTick, currentTick) {
  const span = startTick - gradTick;              // positive (gradTick is the lower tick)
  if (!span) return 0;
  const done = startTick - currentTick;
  return Math.max(0, Math.min(1, done / span));
}

// Token price in ETH from a raw tick (currency0=ETH, currency1=token). Decimals-naive:
// wire the token/quote decimals + an ETH/USD feed for exact live display. Kept for
// completeness; the demo drives display from mock USD figures.
export function tickToPriceEth(tick) {
  return Math.pow(1.0001, -tick);
}

// ── formatting ────────────────────────────────────────────────────────────────
export function fmtUsd(n, opts = {}) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (opts.compact && abs >= 1000) return '$' + compact(n);
  if (abs > 0 && abs < 0.01) {
    // tiny sub-cent price: show enough significant figures
    return '$' + n.toPrecision(3).replace(/(\.\d*?[1-9])0+$/, '$1');
  }
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function compact(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(abs >= 1e11 ? 0 : 2).replace(/\.00$/, '') + 'B';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(abs >= 1e8 ? 0 : 2).replace(/\.00$/, '') + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return sign + abs.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtEth(n, dp = 4) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp }) + ' ETH';
}

export function fmtPct(n, withSign = false) {
  if (n == null || !isFinite(n)) return '—';
  const s = (withSign && n > 0 ? '+' : '') + n.toFixed(n % 1 === 0 ? 0 : 1) + '%';
  return s;
}

export function fmtToken(n) {
  if (n == null || !isFinite(n)) return '—';
  return compact(n);
}

export function shortAddr(a, lead = 6, tail = 4) {
  if (!a || a.length < lead + tail + 2) return a || '—';
  return a.slice(0, lead) + '…' + a.slice(-tail);
}

// seconds → "18d 4h" / "4h 12m" / "12m" live countdown label
export function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── deterministic address → gradient avatar (ENS-style) ─────────────────────────
export function avatarGradient(addr) {
  const a = (addr || '0x0').toLowerCase().replace(/[^0-9a-f]/g, '0').padEnd(40, '0');
  const h1 = parseInt(a.slice(0, 4), 16) % 360;
  const h2 = (h1 + 60 + (parseInt(a.slice(4, 8), 16) % 180)) % 360;
  const h3 = (h2 + 40 + (parseInt(a.slice(8, 12), 16) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 82% 62%), hsl(${h2} 80% 56%) 55%, hsl(${h3} 78% 50%))`;
}

// ── misc DOM helpers ──────────────────────────────────────────────────────────
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
}

export function param(name) {
  return new URLSearchParams(location.search).get(name);
}

export function explorerUrl(addr) {
  return `${CHAIN.explorer}/address/${addr}`;
}

// ── theme (prefers-color-scheme + manual toggle, persisted) ─────────────────────
export function initTheme(btn) {
  const KEY = 'robin-theme';
  const apply = (t) => {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    if (btn) btn.textContent = t === 'dark' ? '◐' : t === 'light' ? '◑' : '◒';
    if (btn) btn.setAttribute('title', `Theme: ${t} (click to change)`);
  };
  let cur = localStorage.getItem(KEY) || 'system';
  apply(cur);
  if (btn) btn.addEventListener('click', () => {
    cur = cur === 'system' ? 'dark' : cur === 'dark' ? 'light' : 'system';
    localStorage.setItem(KEY, cur);
    apply(cur);
  });
}

// convenience re-exports for pages
export { CHAIN, ADDR, COINS, GRAD };
