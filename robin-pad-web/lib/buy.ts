'use client';
import type { Address, Hash, PublicClient } from 'viem';
import { CONFIG } from './config';
import { robinhood } from './chain';
import { erc20Abi, permit2Abi, universalRouterAbi } from './abi';
import { poolKeyFor } from './pool';
import { buildExactInSwap, quoteExactIn } from './swap';

// Buying a launch with USDG through the Universal Router, shared by the trade
// panel's flow and the create page's first buy. Approvals are for the exact
// amount (never unlimited), and the router's Permit2 allowance expires after a day.

// wagmi's writeContractAsync. Typed loosely on purpose: its exact type is tied to
// the app's registered config, and every call below spells out its own ABI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Write = (args: any) => Promise<Hash>;
type Step = (label: string) => void;
const PERMIT2_EXPIRY_SEC = 60 * 60 * 24;

async function waitOk(pc: PublicClient, hash: Hash, what: string) {
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${what} failed on-chain`);
}

/** Lets the router spend `amount` of `asset` for `account` (ERC-20 -> Permit2, Permit2 -> router), skipping what's already in place. */
export async function approveForRouter(pc: PublicClient, write: Write, account: Address, asset: Address, amount: bigint, step: Step) {
  const erc20Allow = await pc.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [account, CONFIG.permit2] });
  if (erc20Allow < amount) {
    step('Approving this amount…');
    await waitOk(pc, await write({ chainId: robinhood.id, address: asset, abi: erc20Abi, functionName: 'approve', args: [CONFIG.permit2, amount] }), 'Token approval');
  }
  const [permit2Allow, expiration] = await pc.readContract({ address: CONFIG.permit2, abi: permit2Abi, functionName: 'allowance', args: [account, asset, CONFIG.router] });
  const nowSec = Math.floor(Date.now() / 1000);
  if (permit2Allow < amount || expiration <= nowSec + 60) {
    step('Letting the router use this amount…');
    await waitOk(pc, await write({ chainId: robinhood.id, address: CONFIG.permit2, abi: permit2Abi, functionName: 'approve', args: [asset, CONFIG.router, amount, nowSec + PERMIT2_EXPIRY_SEC] }), 'Router approval');
  }
}

/**
 * Buys `token` with `usdgIn`: quotes the live pool, then sends the swap with
 * `slippageBps` of room (checked on-chain as the minimum out). Approvals must
 * already be in place (approveForRouter). Returns the swap's hash.
 */
export async function buyWithUsdg(pc: PublicClient, write: Write, account: Address, token: Address, usdgIn: bigint, slippageBps: number, step: Step): Promise<Hash> {
  const { key, tokenIsToken0 } = poolKeyFor(token);
  const side = { key, zeroForOne: !tokenIsToken0, currencyIn: CONFIG.usdg, currencyOut: token, amountIn: usdgIn };
  step('Getting a price…');
  const out = await quoteExactIn(pc, side);
  if (out === 0n) throw new Error('The pool has nothing to sell at the moment.');
  const amountOutMin = (out * BigInt(10_000 - slippageBps)) / 10_000n;
  const { args } = buildExactInSwap({ ...side, amountOutMin });
  step('Checking the swap…');
  await pc.simulateContract({ address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args, account });
  step('Swap waiting on your wallet…');
  const hash = await write({ chainId: robinhood.id, address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args });
  step(`Waiting for ${CONFIG.chainName}…`);
  await waitOk(pc, hash, 'Swap');
  return hash;
}
