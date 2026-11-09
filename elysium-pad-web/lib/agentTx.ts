import 'server-only';
import { encodeFunctionData, isAddress, parseUnits, formatUnits, type Address, type Hex } from 'viem';
import { CONFIG } from './config';
import { FEES } from './fees';
import { portalAbi, erc20Abi, permit2Abi, universalRouterAbi } from './abi';
import { chainClient, getLaunches } from './launches';
import { poolKeyFor } from './pool';
import { buildExactInSwap, quoteExactIn } from './swap';
import { MAX_DESCRIPTION, metaMessage, normalizeContent } from './metaAuth';

// Transactions for software agents. Everything here is calldata for the agent's
// own wallet to sign and send: this site holds no keys and broadcasts nothing.

export type TxStep = { description: string; to: Address; data: Hex; value: '0'; chainId: number; gas?: string };

const PERMIT2_EXPIRY_SEC = 60 * 60 * 24;
const LAUNCH_GAS = 2_800_000n; // a launch uses about 2.3M

const num = (v: unknown, lo: number, hi: number, label: string): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${label} has to be a number from ${lo} to ${hi}`);
  return n;
};
const asAddress = (v: unknown, label: string): Address => {
  if (typeof v !== 'string' || !isAddress(v)) throw new Error(`${label} has to be a 0x address`);
  return v.toLowerCase() as Address;
};

/** createLaunch calldata. With `from`, it is also dry-run on chain so a bad input fails here with its reason. */
export async function prepareLaunch(a: Record<string, unknown>) {
  const name = String(a.name ?? '').trim();
  const symbol = String(a.symbol ?? '').toUpperCase();
  if (name.length < 2 || name.length > 32) throw new Error('name has to be 2 to 32 characters');
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw new Error('symbol has to be 2 to 10 letters or digits');
  const mc = num(a.market_cap_usd ?? 10000, 100, 1_000_000, 'market_cap_usd');
  const buy = num(a.buy_tax_pct ?? 3, 0, 10, 'buy_tax_pct');
  const sell = num(a.sell_tax_pct ?? 3, 0, 10, 'sell_tax_pct');
  const buyTaxBps = Math.round(buy * 100), sellTaxBps = Math.round(sell * 100);
  const args = [{ name, symbol, startingMarketCapQuote: parseUnits(String(mc), CONFIG.quoteDecimals), buyTaxBps, sellTaxBps }] as const;
  const data = encodeFunctionData({ abi: portalAbi, functionName: 'createLaunch', args });
  let gas = LAUNCH_GAS;
  let checked = false;
  if (a.from !== undefined) {
    const from = asAddress(a.from, 'from');
    await chainClient.simulateContract({ address: CONFIG.portal, abi: portalAbi, functionName: 'createLaunch', args, account: from });
    gas = ((await chainClient.estimateContractGas({ address: CONFIG.portal, abi: portalAbi, functionName: 'createLaunch', args, account: from })) * 12n) / 10n;
    checked = true;
  }
  const step: TxStep = { description: `Launch ${symbol}: $${mc} market cap, ${buy}% buy tax, ${sell}% sell tax`, to: CONFIG.portal, data, value: '0', chainId: CONFIG.chainId, gas: gas.toString() };
  return {
    chainId: CONFIG.chainId, steps: [step], dryRunPassed: checked,
    terms: { marketCapUsd: mc, liquidityUsd: mc, buyTaxPct: buy, sellTaxPct: sell, creatorSharePctOfTax: FEES.creatorPct, platformSharePctOfTax: FEES.platformPct },
    next: 'Sign and send the step from the wallet that should own the token (needs HYPE for gas). Read the new token address from the LaunchCreated event in the receipt (topic 1), or from elysium_list_launches. Then optionally call elysium_details_message to add a description, image and links.',
  };
}

/** Approvals and the swap for one trade, with a live quote. */
export async function prepareTrade(a: Record<string, unknown>) {
  const token = asAddress(a.token, 'token');
  const side = String(a.side ?? '');
  if (side !== 'buy' && side !== 'sell') throw new Error('side has to be "buy" or "sell"');
  const slippage = Math.round(num(a.slippage_bps ?? 300, 0, 5000, 'slippage_bps'));
  const amountStr = String(a.amount ?? '');
  if (!/^\d+(\.\d+)?$/.test(amountStr) || Number(amountStr) <= 0) throw new Error(side === 'buy' ? 'amount is the USDC to spend, e.g. "25.5"' : 'amount is the number of tokens to sell, e.g. "1000000"');
  const from = a.from !== undefined ? asAddress(a.from, 'from') : undefined;

  const { launches } = await getLaunches(token);
  const launch = launches[0];
  if (!launch) throw new Error('Elysium Pad did not launch that token.');
  const { key, tokenIsToken0 } = poolKeyFor(launch.token, launch.hook);
  const buying = side === 'buy';
  const asset = buying ? CONFIG.usdc : launch.token;
  const out = buying ? launch.token : CONFIG.usdc;
  const inDec = buying ? CONFIG.quoteDecimals : 18, outDec = buying ? 18 : CONFIG.quoteDecimals;
  const amountIn = parseUnits(amountStr, inDec);
  const swapSide = { key, zeroForOne: buying ? !tokenIsToken0 : tokenIsToken0, currencyIn: asset, currencyOut: out, amountIn };
  const quoted = await quoteExactIn(chainClient, swapSide);
  if (quoted === 0n) throw new Error(buying ? 'The pool has nothing to sell right now.' : 'The pool has nothing to fill a sell against yet (nobody has bought).');
  const minOut = (quoted * BigInt(10_000 - slippage)) / 10_000n;
  const { args } = buildExactInSwap({ ...swapSide, amountOutMin: minOut, deadlineSec: 1800 });

  const steps: TxStep[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  let needErc20 = true, needPermit = true;
  if (from) {
    const [erc20Allow, [p2Allow, p2Exp]] = await Promise.all([
      chainClient.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [from, CONFIG.permit2] }),
      chainClient.readContract({ address: CONFIG.permit2, abi: permit2Abi, functionName: 'allowance', args: [from, asset, CONFIG.router] }),
    ]);
    needErc20 = erc20Allow < amountIn;
    needPermit = p2Allow < amountIn || p2Exp <= nowSec + 60;
  }
  if (needErc20) steps.push({ description: 'Let Permit2 spend this exact amount', to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONFIG.permit2, amountIn] }), value: '0', chainId: CONFIG.chainId });
  if (needPermit) steps.push({ description: 'Let the router spend this exact amount (expires in 24h)', to: CONFIG.permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [asset, CONFIG.router, amountIn, nowSec + PERMIT2_EXPIRY_SEC] }), value: '0', chainId: CONFIG.chainId });
  steps.push({ description: `${buying ? 'Buy' : 'Sell'} ${launch.symbol} through the router`, to: CONFIG.router, data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args }), value: '0', chainId: CONFIG.chainId });
  return {
    chainId: CONFIG.chainId, token: launch.token, symbol: launch.symbol, side,
    quote: { amountIn: amountIn.toString(), amountInHuman: amountStr, expectedOut: quoted.toString(), expectedOutHuman: formatUnits(quoted, outDec), minOut: minOut.toString(), minOutHuman: formatUnits(minOut, outDec), slippageBps: slippage },
    approvalsChecked: !!from,
    steps,
    next: 'Send the steps in order, waiting for each to be mined. The swap reverts on chain if the price moves past minOut, and its deadline is 30 minutes. Pass `from` to skip approvals that are already in place.',
  };
}

/** The exact text the token's creator signs (personal_sign) to set its page, plus how to submit it. */
export function detailsMessage(a: Record<string, unknown>, origin: string) {
  const token = asAddress(a.token, 'token');
  const content = normalizeContent({ description: a.description, split: a.split, links: a.links });
  const image = a.image_sha256 === undefined || a.image_sha256 === null ? null : String(a.image_sha256);
  if (image !== null && !/^0x[0-9a-fA-F]{64}$/.test(image)) throw new Error('image_sha256 has to be the 0x-prefixed SHA-256 of the image file');
  const issuedAt = Math.floor(Date.now() / 1000);
  const message = metaMessage({ token, chainId: CONFIG.chainId, content, image: image as Hex | null, issuedAt });
  return {
    message, issuedAt,
    howToSubmit: {
      step1: 'Sign `message` with personal_sign (EIP-191) from the wallet that launched the token, within 10 minutes.',
      step2: `POST multipart/form-data to ${origin}/api/metadata/${token} with fields: description, split (JSON, e.g. {"creator":0,"buyback":0,"dividends":0,"liquidity":0}), links (JSON: x, website, telegram), issuedAt, signature, and optionally image (PNG, JPG or GIF, 4 MB max).`,
      limits: `Description up to ${MAX_DESCRIPTION} characters; links must be https; x links on x.com or twitter.com, telegram on t.me.`,
    },
  };
}
