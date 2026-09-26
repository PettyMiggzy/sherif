import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, formatUnits, parseAbi,
  type Address, type Hex, type PublicClient,
} from 'viem';

// Every custom error the Robin Labs Pad contracts, and the Uniswap v4 / Permit2 /
// ERC-20 code they call into, can revert with. Merged into a write's ABI so
// viem names a nested revert instead of printing "unknown signature 0x…".
export const knownErrorsAbi = parseAbi([
  // RobinPortal, RobinHook, RobinLocker, RobinRevenueSplitter
  'error TaxTooHigh()',
  'error StartingMcOutOfRange()',
  'error ZeroAddress()',
  'error NotAuthorizedPortal()',
  'error AlreadyRegistered()',
  'error UnknownPool()',
  'error NothingToFlush()',
  'error NotInitializer()',
  'error LiquidityLocked()',
  'error PartialFillUnsupported()',
  'error NoLiquidityToFill()',
  'error NotSeededYet()',
  'error NothingToHarvest()',
  'error NotAuthorized()',
  'error NothingToClaim()',
  'error InvalidRecipient()',
  // Uniswap v4 PoolManager and UniversalRouter, Permit2
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error PoolAlreadyInitialized()',
  'error PoolNotInitialized()',
  'error CurrencyNotSettled()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error TransactionDeadlinePassed()',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  // OpenZeppelin ERC-20 (launch tokens)
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
]);

const MESSAGES: Record<string, string> = {
  TaxTooHigh: 'Tax can be at most 10% on each side.',
  StartingMcOutOfRange: 'That opening value is out of range ($100 to $1T).',
  NoLiquidityToFill: 'No USDG in this pool yet: someone has to buy before anyone can sell.',
  V4TooLittleReceived: 'Price shifted beyond the slippage you set. Refresh the quote or allow more slippage.',
  TransactionDeadlinePassed: 'This swap sat too long and hit its deadline. Send it again.',
  AllowanceExpired: 'The router permission ran out. Retry and it will be renewed.',
  InsufficientAllowance: 'This amount is more than the router may spend. Retry and the limit will be raised.',
  ERC20InsufficientBalance: "This wallet doesn't hold enough of that token.",
  ERC20InsufficientAllowance: 'Spending this token needs an approval first. Retry and approve it.',
  NothingToFlush: 'The hook is holding no tax for this pool right now.',
  NothingToHarvest: "The pool hasn't earned any LP fees since the last harvest.",
  NothingToClaim: 'Your claimable balance is zero for now.',
  NotAuthorized: "That action is reserved for the token's creator.",
  InvalidRecipient: "That address can't receive this payout.",
};

const GAS_HELP = 'This wallet is short on ETH for gas. Robinhood Chain charges gas in ETH; a few cents of ETH covers many trades.';
const NO_GAS = /insufficient funds|exceeds the balance|gas required exceeds allowance/i;

function innerErrorName(data: unknown): string | undefined {
  if (typeof data !== 'string' || data.length < 10) return undefined;
  try {
    return decodeErrorResult({ abi: knownErrorsAbi, data: data as Hex }).errorName;
  } catch {
    return undefined;
  }
}

type ErrLike = { shortMessage?: string; details?: string; message?: string; cause?: unknown };

/** Every message in the error's cause chain, so nothing a wallet or node said is lost. */
function fullText(e: unknown): string {
  const parts: string[] = [];
  let x = e as ErrLike | undefined;
  for (let i = 0; x && i < 8; i++, x = x.cause as ErrLike | undefined) {
    // viem errors carry a short message plus details; anything else only has message.
    for (const p of [x.shortMessage, x.details, x.shortMessage ? undefined : x.message]) {
      if (p && !parts.includes(p)) parts.push(p);
    }
  }
  return parts.join(' — ');
}

const clip = (s: string, n = 320) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A wallet or contract error in plain words, with the actual reason.
 * viem puts the reason on the error's second line; the first line alone
 * would end at "reverted with the following reason:" with nothing after it.
 */
export function explainTxError(e: unknown): string {
  if (!(e instanceof BaseError)) return clip(e instanceof Error ? e.message : String(e));
  if (e.walk((x) => x instanceof UserRejectedRequestError)) return 'Declined in the wallet, so nothing was sent.';
  const text = fullText(e);
  if (NO_GAS.test(text)) return GAS_HELP;
  const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (rev instanceof ContractFunctionRevertedError) {
    let name = rev.data?.errorName;
    if (name === 'WrappedError') name = innerErrorName(rev.data?.args?.[2]) ?? name;
    if (name === 'ExecutionFailed') name = innerErrorName(rev.data?.args?.[1]) ?? name;
    if (name && MESSAGES[name]) return MESSAGES[name];
    if (name && name !== 'Error' && name !== 'Panic') return `Contract said no (${name}).`;
    if (rev.reason) return clip(`Reverted with reason: ${rev.reason}`);
    if (rev.signature) return `Contract said no (error ${rev.signature}).`;
  }
  return clip(text);
}

/**
 * Throws a readable error when the wallet can't cover `gas` at current fees.
 * Robinhood Chain pays gas in ETH (trades are in USDG), and wallets reserve
 * gasLimit × maxFeePerGas up front.
 */
export async function ensureGasFunds(pc: PublicClient, account: Address, gas: bigint) {
  const [balance, fees] = await Promise.all([pc.getBalance({ address: account }), pc.estimateFeesPerGas()]);
  const need = gas * fees.maxFeePerGas;
  if (balance < need) {
    const eth = (v: bigint) => Number(formatUnits(v, 18)).toFixed(6);
    throw new Error(`Short on gas: this needs about ${eth(need)} ETH and the wallet holds ${eth(balance)} ETH. Gas on Robinhood Chain is paid in ETH.`);
  }
}
