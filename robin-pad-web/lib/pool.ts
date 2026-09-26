import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { CONFIG } from './config';

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export function poolKeyFor(token: Address): { key: PoolKey; tokenIsToken0: boolean } {
  const tokenIsToken0 = token.toLowerCase() < CONFIG.usdg.toLowerCase();
  const key: PoolKey = {
    currency0: tokenIsToken0 ? token : CONFIG.usdg,
    currency1: tokenIsToken0 ? CONFIG.usdg : token,
    fee: CONFIG.poolFee,
    tickSpacing: CONFIG.tickSpacing,
    hooks: CONFIG.hook,
  };
  return { key, tokenIsToken0 };
}

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/**
 * Uniswap v4 Pool.State is at keccak(poolId . POOLS_SLOT); slot0 is word 0
 * of that struct. POOLS_SLOT = 6 — verified directly against our pinned
 * v4-core rev via `forge inspect PoolManager storage-layout`, not assumed.
 */
export function slot0Slot(id: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
}

export function decodeSlot0(word: Hex) {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  if (tick >= 1 << 23) tick -= 1 << 24;
  const lpFee = Number((v >> 208n) & ((1n << 24n) - 1n));
  return { sqrtPriceX96, tick, lpFee };
}

/** Price of 1 launch token in quote units (human), from sqrtPriceX96. */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsToken0: boolean, quoteDecimals: number, tokenDecimals = 18) {
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const raw1per0 = sp * sp; // token1 per token0, raw units
  return tokenIsToken0
    ? raw1per0 * 10 ** (tokenDecimals - quoteDecimals)
    : (1 / raw1per0) * 10 ** (tokenDecimals - quoteDecimals);
}

/** Price of 1 launch token in quote units (human) at a tick boundary. */
export function priceFromTick(tick: number, tokenIsToken0: boolean, quoteDecimals: number, tokenDecimals = 18) {
  const raw1per0 = 1.0001 ** tick; // token1 per token0, raw units
  return tokenIsToken0
    ? raw1per0 * 10 ** (tokenDecimals - quoteDecimals)
    : (1 / raw1per0) * 10 ** (tokenDecimals - quoteDecimals);
}
