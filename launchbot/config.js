// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Launch Bot — config
//
// Live chain + contract addresses (mirrors sdk/robinlabs.mjs) plus the bot's own
// tunables. Self-contained so the Docker image needs only this folder.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';

export const CHAIN = {
  id: 4663,
  hex: '0x1237',
  name: 'Robinhood Chain',
  currency: 'ETH',
  explorer: 'https://robinhoodchain.blockscout.com',
  perTxGasCap: 16_777_216, // 2^24 — a launch is heavy; clamp gasLimit under this
};

// Source-verified deployment (Blockscout + Sourcify, chain 4663).
export const ADDRESSES = {
  factory: '0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074', // one-call launch
  router: '0xA6BaAB820809C7fC8350311776627298f91F07eC', // every buy/sell
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};

// Human-readable ABIs (ethers v6 parses directly).
export const ABI = {
  factory: [
    'function launch((string name,string symbol,address dev,(uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,address projectWallet) tax) p) payable returns (address token,address curve,address pool)',
    'event Launched(address indexed token,address indexed curve,address indexed pool,address dev,uint256 devBought)',
  ],
  router: [
    'function buy(address token,uint256 minOut) payable returns (uint256 tokensOut)',
    'function sell(address token,uint256 amountIn,uint256 minOutEth) returns (uint256 ethOut)',
    'function configOf(address token) view returns ((address pool,address curve,address projectWallet,uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,bool set))',
    'function bondOf(address token) view returns (address)',
  ],
  erc20: [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner,address spender) view returns (uint256)',
    'function approve(address spender,uint256 amount) returns (bool)',
  ],
};

// Default launch tax mirrors the create page: the 1% baseline, 100% of any
// above-1% share to the project wallet (the dev). Buy/sell must be ≥100 and ≤400
// bps; wallet+floor+burn must sum to 10000; projectWallet 0 ⇒ dev.
export const DEFAULT_TAX = {
  buyBps: 100,
  sellBps: 100,
  walletBps: 10000,
  floorBps: 0,
  burnBps: 0,
  projectWallet: '0x0000000000000000000000000000000000000000',
};

function req(name) {
  const v = (process.env[name] || '').trim();
  if (!v) { console.error(`Missing env ${name} — copy .env.example to .env and fill it in`); process.exit(1); }
  return v;
}

// MASTER_SECRET protects every custodial key; a weak value makes a leaked
// keystore brute-forceable offline. Demand real entropy.
function reqSecret(name, minLen) {
  const v = req(name);
  if (v.length < minLen) {
    console.error(`${name} is too weak (${v.length} chars). Use a high-entropy random value: openssl rand -hex 32`);
    process.exit(1);
  }
  return v;
}

// Parse a bounded number env with a safe default (NaN/out-of-range → default).
function numEnv(name, def, min, max) {
  let n = Number(process.env[name]);
  if (!Number.isFinite(n)) n = def;
  return Math.min(max, Math.max(min, n));
}

export const CFG = {
  botToken: req('TELEGRAM_BOT_TOKEN'),
  // The RPC used to sign & broadcast. MUST accept eth_sendRawTransaction (not the
  // read-only indexer /rpc proxy). A key in the URL is a SECRET — keep it in .env.
  rpc: req('RPC_URL'),
  // 32+ char secret that encrypts every custodial private key at rest. If this
  // leaks, every wallet is compromised; if it's lost, every wallet is unrecoverable.
  masterSecret: reqSecret('MASTER_SECRET', 32),
  apiBase: (process.env.API_BASE || 'https://api.robinlab.io').replace(/\/+$/, ''),
  siteBase: (process.env.SITE_BASE || 'https://robinlab.io').replace(/\/+$/, ''),
  // Public Terms/Privacy URL, shown in /start and /disclaimer (Telegram §4/§9.1).
  termsUrl: (process.env.TERMS_URL || '').trim(),
  // Min seconds between one user's launches (anti-spam; Telegram §5.2b/f).
  launchCooldownSecs: numEnv('LAUNCH_COOLDOWN_SECS', 60, 0, 86400),
  adminId: (process.env.ADMIN_ID || '').trim(),
  // Optional group/channel to announce new launches into (free promo). The bot
  // must be a member/admin. Blank = disabled. Posting to your own channel is
  // fine under Telegram ToS; we never DM users unsolicited.
  announceChatId: (process.env.ANNOUNCE_CHAT_ID || '').trim(),
  // Slippage tolerance for /buy and /sell (percent), clamped to [0, 99].
  slippagePct: numEnv('SLIPPAGE_PCT', 12, 0, 99),
  // Optional flat bot fee (in ETH) taken from a user's balance per launch — extra
  // revenue on top of trade fees. 0 = off. Sent to FEE_WALLET.
  launchFeeEth: (process.env.LAUNCH_FEE_ETH || '0').trim(),
  feeWallet: (process.env.FEE_WALLET || '').trim(),
  dataDir: (process.env.DATA_DIR || './data').trim(),
};

export const tgApi = `https://api.telegram.org/bot${CFG.botToken}`;
export const tgFile = `https://api.telegram.org/file/bot${CFG.botToken}`;
export const explorerTx = (h) => `${CHAIN.explorer}/tx/${h}`;
export const explorerAddr = (a) => `${CHAIN.explorer}/address/${a}`;
export const coinUrl = (t) => `${CFG.siteBase}/pad/token.html?a=${t}`;
