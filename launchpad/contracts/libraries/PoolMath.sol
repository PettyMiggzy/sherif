// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PoolMath
/// @notice Just enough Uniswap v3 math for the launchpad, built ONLY on OZ Math (mulDiv/sqrt).
/// We deliberately avoid TickMath/FullMath: milestone triggers use tick-offset arithmetic and
/// `launchTick` is read straight from slot0, so we never convert tick<->price on-chain.
library PoolMath {
    uint256 internal constant Q96 = 0x1000000000000000000000000; // 2**96
    uint256 internal constant Q192 = 0x1000000000000000000000000000000000000000000000000; // 2**192

    // Full-range position bounds (MIN/MAX tick snapped to tickSpacing 200) and their sqrt ratios,
    // precomputed off-chain (verified) so no TickMath is needed.
    int24 internal constant MIN_TICK = -887200;
    int24 internal constant MAX_TICK = 887200;
    // Exact Uniswap TickMath.getSqrtRatioAtTick(±887200) — must match what a real pool uses.
    uint160 internal constant SQRT_RATIO_AT_MIN_TICK = 4310618292;
    uint160 internal constant SQRT_RATIO_AT_MAX_TICK = 1456195216270955103206513029158776779468408838535;

    // Absolute pool bounds (for unbounded swaps, we clamp just inside these).
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @notice sqrtPriceX96 = sqrt(amount1 / amount0) * 2**96, derived from the seed deposit ratio.
    /// @dev 512-bit safe via mulDiv; result must fit in uint160.
    function sqrtPriceX96FromAmounts(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        require(amount0 > 0 && amount1 > 0, "amounts=0");
        uint256 ratioX192 = Math.mulDiv(amount1, Q192, amount0);
        uint256 sqrtP = Math.sqrt(ratioX192);
        require(sqrtP <= type(uint160).max, "sqrtP overflow");
        // Bound to the full-range POSITION's tick-snapped sqrt ratios (not the absolute pool bounds),
        // so fullRangeLiquidity's (sqrtB - sqrtP) / (sqrtP - sqrtA) can never underflow.
        require(sqrtP > SQRT_RATIO_AT_MIN_TICK && sqrtP < SQRT_RATIO_AT_MAX_TICK, "price out of range");
        return uint160(sqrtP);
    }

    /// @notice Liquidity for a full-range position given the current price and both amounts.
    /// Standard Uniswap LiquidityAmounts.getLiquidityForAmounts specialized to the full range;
    /// returns min(L0, L1) so neither owed amount can exceed what we hold.
    function fullRangeLiquidity(uint160 sqrtP, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128 liquidity)
    {
        uint160 sqrtA = SQRT_RATIO_AT_MIN_TICK;
        uint160 sqrtB = SQRT_RATIO_AT_MAX_TICK;
        // sqrtP is guaranteed strictly between sqrtA and sqrtB for any launch price.
        uint256 l0 = _liquidityForAmount0(sqrtP, sqrtB, amount0);
        uint256 l1 = _liquidityForAmount1(sqrtA, sqrtP, amount1);
        uint256 l = l0 < l1 ? l0 : l1;
        require(l > 0 && l <= type(uint128).max, "bad liquidity");
        liquidity = uint128(l);
    }

    function _liquidityForAmount0(uint160 sqrtLower, uint160 sqrtUpper, uint256 amount0)
        private
        pure
        returns (uint256)
    {
        // L = amount0 * (sqrtLower * sqrtUpper / Q96) / (sqrtUpper - sqrtLower)
        uint256 intermediate = Math.mulDiv(uint256(sqrtLower), uint256(sqrtUpper), Q96);
        return Math.mulDiv(amount0, intermediate, uint256(sqrtUpper) - uint256(sqrtLower));
    }

    function _liquidityForAmount1(uint160 sqrtLower, uint160 sqrtUpper, uint256 amount1)
        private
        pure
        returns (uint256)
    {
        // L = amount1 * Q96 / (sqrtUpper - sqrtLower)
        return Math.mulDiv(amount1, Q96, uint256(sqrtUpper) - uint256(sqrtLower));
    }

    /// @notice Arithmetic-mean tick over `window` seconds from the pool's oracle cumulatives.
    function meanTick(int56 tickCumulativeStart, int56 tickCumulativeEnd, uint32 window)
        internal
        pure
        returns (int24)
    {
        int56 delta = tickCumulativeEnd - tickCumulativeStart;
        int56 avg = delta / int56(uint56(window));
        // Round toward negative infinity (matches Uniswap OracleLibrary) for exactness.
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) avg--;
        return int24(avg);
    }

    /// @notice price(WETH per token, scaled by 1e18) implied by a sqrtPriceX96, respecting ordering.
    /// Only used for slippage/min-out estimates, never for the milestone gate.
    /// @dev Never squares the full sqrtPrice directly (that overflows uint256 for large sqrtPrice);
    /// the intermediate is divided by Q96 first so mulDiv stays in range.
    function quoteWethPerToken(uint160 sqrtPriceX96, bool tokenIsToken0) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        if (tokenIsToken0) {
            // WETH per token = (sqrtP/2^96)^2, scaled by 1e18
            uint256 p = Math.mulDiv(s, s, Q96); // = price * 2^96, no overflow
            return Math.mulDiv(p, 1e18, Q96);
        } else {
            // token is token1: WETH per token = (2^96/sqrtP)^2 = 2^192 / sqrtP^2, scaled by 1e18
            uint256 a = Math.mulDiv(Q96, 1e18, s);
            return Math.mulDiv(a, Q96, s);
        }
    }
}
