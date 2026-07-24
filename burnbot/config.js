// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs — Buyback & Burn Bot · config
//
// Off-chain buyback-and-burn: a wallet you fund with ETH buys $ROBIN through the
// live PadRouter and sends it to the dead address. NO contract deploy, no pad
// change — it uses the same router every trade goes through.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';

export const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  explorer: 'https://robinhoodchain.blockscout.com',
  perTxGasCap: 16_777_216, // 2^24
};

// Live, source-verified deployment (chain 4663).
export const ADDR = {
  router: '0xA6BaAB820809C7fC8350311776627298f91F07eC', // every buy/sell
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};

// The burn sink. Tokens sent here are unspendable forever.
export const DEAD = '0x000000000000000000000000000000000000dEaD';

export const ABI = {
  router: [
    'function buy(address token,uint256 minOut) payable returns (uint256 tokensOut)',
    'function bondOf(address token) view returns (address)',
    'function configOf(address token) view returns ((address pool,address curve,address projectWallet,uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,bool set))',
  ],
  erc20: [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
  ],
};

function req(name) {
  const v = (process.env[name] || '').trim();
  if (!v) { console.error(`Missing env ${name} — copy .env.example to .env and fill it in`); process.exit(1); }
  return v;
}
function numEnv(name, def, min, max) {
  let n = Number(process.env[name]);
  if (!Number.isFinite(n)) n = def;
  return Math.min(max, Math.max(min, n));
}
// A plain decimal-string ETH amount (or '' if unset) — never sci-notation, so parseEther can't throw.
function ethEnv(name, def) {
  const v = (process.env[name] || '').trim();
  return /^\d{1,9}(\.\d{1,18})?$/.test(v) ? v : def;
}

export const CFG = {
  rpc: req('RPC_URL'),                 // broadcast-capable RPC (accepts eth_sendRawTransaction)
  pk: req('BURN_PRIVATE_KEY'),         // the burn wallet's key — SECRET, .env only, never committed
  token: (process.env.TOKEN || '0x6696FE29288B586017E6f264c0091DBA6C5ebeaf').trim(), // $ROBIN by default
  // How much ETH to spend per dip-buy: a decimal amount, or 'max'. Small + hourly
  // by default (0.05/cycle → ~2.4 ETH lasts ~48h of hourly dip-buys).
  buyback: (process.env.BUYBACK_ETH || '0.05').trim(),
  gasReserve: ethEnv('GAS_RESERVE_ETH', '0.003'), // always keep this much for gas
  minBalance: ethEnv('MIN_BALANCE_ETH', '0.01'),  // don't buy below this balance (avoid dust)
  slippagePct: numEnv('SLIPPAGE_PCT', 15, 0, 99),
  intervalMin: numEnv('INTERVAL_MIN', 60, 1, 100000), // scheduled-mode cadence (default hourly)
  // Buy only on dips: buy when the price is at least DIP_PCT below the rolling
  // average over the last DIP_WINDOW_HRS. DIP_PCT=0 buys every cycle (no gate).
  dipPct: numEnv('DIP_PCT', 4, 0, 90),
  dipWindowHrs: numEnv('DIP_WINDOW_HRS', 48, 1, 720),
  probeEth: ethEnv('PROBE_ETH', '0.01'), // price-probe size (read-only quote)
  tgToken: (process.env.TG_BOT_TOKEN || '').trim(),    // optional burn announcements
  tgChat: (process.env.TG_CHAT_ID || '').trim(),
  // Burn announcements show a row of this emoji, scaled to the burn's ETH value:
  // one per EMOJI_STEP_ETH, capped at EMOJI_MAX. Bigger burn → more emojis.
  // For a CUSTOM (animated) Telegram emoji, set CUSTOM_EMOJI_ID to its numeric id
  // (get it with `node getEmojiId.js` after sending the emoji to the bot). The
  // BURN_EMOJI char is the fallback non-Premium viewers see.
  emoji: (process.env.BURN_EMOJI || '🦊').trim() || '🦊',
  customEmojiId: (process.env.CUSTOM_EMOJI_ID || '').trim(),
  emojiStepEth: numEnv('EMOJI_STEP_ETH', 0.01, 0.0001, 100),
  emojiMax: numEnv('EMOJI_MAX', 50, 1, 200),
  dataDir: (process.env.DATA_DIR || './data').trim(),
};

export const explorerTx = (h) => `${CHAIN.explorer}/tx/${h}`;
export const explorerAddr = (a) => `${CHAIN.explorer}/address/${a}`;
