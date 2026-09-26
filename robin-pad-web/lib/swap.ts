import { encodeAbiParameters, encodeFunctionData, encodePacked, decodeErrorResult, parseAbi, maxUint256, type Address, type Hex, type PublicClient } from 'viem';
import type { PoolKey } from './pool';
import { universalRouterAbi } from './abi';
import { CONFIG } from './config';

// UniversalRouter command + v4 action ids. SWAP_EXACT_IN_SINGLE (0x06),
// SETTLE_ALL (0x0c), TAKE_ALL (0x0f) verified directly against this repo's
// pinned v4-periphery Actions.sol. CMD_V4_SWAP (0x10) comes from Uniswap's
// separate `universal-router` repo, which isn't one of this repo's pinned
// dependencies — worth an independent check against that repo before
// relying on it for a real deploy, though it matches known-stable values.
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

const POOL_KEY_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ],
} as const;

const routerErrorsAbi = parseAbi(['error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)']);
const NO_LIQUIDITY_SELECTOR = '43d335e6'; // RobinHook.NoLiquidityToFill()
const WRAPPED_ERROR_SELECTOR = '0x90bfb865'; // PoolManager's WrappedError(address,bytes4,bytes,bytes) around a hook revert

export type SwapSide = { key: PoolKey; zeroForOne: boolean; amountIn: bigint; currencyIn: Address; currencyOut: Address };

function encodeSwapParams(p: SwapSide, amountOutMin: bigint): Hex {
  return encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'poolKey', ...POOL_KEY_TUPLE }, { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' },
        // Robinhood Chain's Universal Router (v2.1.1, as on Arc) has six fields here. This fifth one
        // is a per-hop minimum out/in price scaled by 1e36, not a sqrt price
        // limit (the router always swaps to MIN/MAX_SQRT_PRICE±1); 0 = off.
        // Leaving it out makes every swap revert with empty data.
        { name: 'minHopPriceX36', type: 'uint256' },
        { name: 'hookData', type: 'bytes' },
      ],
    }],
    [{ poolKey: p.key, zeroForOne: p.zeroForOne, amountIn: p.amountIn, amountOutMinimum: amountOutMin, minHopPriceX36: 0n, hookData: '0x' }],
  );
}

const takeAll = (currency: Address, min: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, min]);
const deadlineIn = (sec: number) => BigInt(Math.floor(Date.now() / 1000) + sec);

/** `execute(commands, inputs, deadline)` args for a single-pool exact-input swap (ERC-20 in, ERC-20 out). */
export function buildExactInSwap(p: SwapSide & { amountOutMin: bigint; deadlineSec?: number }) {
  if (p.amountOutMin <= 0n) throw new Error('amountOutMin has to be greater than 0');
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [p.currencyIn, p.amountIn]);
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]);
  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [encodeSwapParams(p, p.amountOutMin), settle, takeAll(p.currencyOut, p.amountOutMin)]]);
  const commands: Hex = encodePacked(['uint8'], [CMD_V4_SWAP]);
  return { args: [commands, [v4Input], deadlineIn(p.deadlineSec ?? 600)] as const };
}

/**
 * Exact output of a swap, from the live pool — hook tax, LP fee, the opening
 * liquidity gap and price impact all included. It eth_calls the router with
 * SWAP then TAKE_ALL(min = max uint): TAKE_ALL reverts with
 * V4TooLittleReceived(min, actual) before any settlement happens, so it needs
 * no balance or approval and never moves funds. Returns 0n when the pool has
 * nothing to fill against (e.g. selling before anyone has bought).
 */
export async function quoteExactIn(client: PublicClient, p: SwapSide): Promise<bigint> {
  const actions = encodePacked(['uint8', 'uint8'], [ACT_SWAP_EXACT_IN_SINGLE, ACT_TAKE_ALL]);
  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [encodeSwapParams(p, 0n), takeAll(p.currencyOut, maxUint256)]]);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [encodePacked(['uint8'], [CMD_V4_SWAP]), [v4Input], deadlineIn(600)] });
  try {
    await client.call({ to: CONFIG.router, data });
  } catch (e) {
    let err: unknown = e;
    for (let i = 0; i < 8 && err; i++) {
      const raw = (err as { data?: unknown }).data;
      const hex = typeof raw === 'string' ? raw : (raw as { data?: unknown } | undefined)?.data;
      // RobinHook reverts a swap that would fill nothing (NoLiquidityToFill,
      // wrapped by the PoolManager) instead of letting it move the price for
      // free. For a quote that means there is nothing to fill against: 0.
      if (typeof hex === 'string' && hex.startsWith('0x')) {
        try {
          const decoded = decodeErrorResult({ abi: routerErrorsAbi, data: hex as Hex });
          return decoded.args[1];
        } catch { /* some other revert */ }
        if (hex.startsWith(WRAPPED_ERROR_SELECTOR) && hex.includes(NO_LIQUIDITY_SELECTOR)) return 0n;
      }
      err = (err as { cause?: unknown }).cause;
    }
    throw e;
  }
  throw new Error('The quote call returned instead of reverting');
}
