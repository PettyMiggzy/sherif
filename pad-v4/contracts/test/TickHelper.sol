// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Test-only: exposes the exact on-chain sqrtPriceX96 for a tick, so a test can initialize a pool
/// precisely at a curve's `startTick` (which the single-sided seed relies on being byte-exact).
contract TickHelper {
    function sqrt(int24 t) external pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t);
    }

    function minUsable(int24 spacing) external pure returns (int24) {
        return TickMath.minUsableTick(spacing);
    }

    function maxUsable(int24 spacing) external pure returns (int24) {
        return TickMath.maxUsableTick(spacing);
    }
}
