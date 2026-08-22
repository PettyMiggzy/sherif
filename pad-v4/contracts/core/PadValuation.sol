// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title PadValuation — the one place that turns (supply, launch tick) into a valuation
/// @notice Robin lets a creator choose their own SUPPLY and their own LAUNCH PRICE. Neither number means
/// anything alone — 10,000 tokens and 10,000,000,000 tokens are equally legitimate; what has to stay sane is
/// their PRODUCT, the implied fully-diluted value at launch. So supply is left completely unconstrained and the
/// FDV is what the factory bounds (`RobinV4FeeConfig.minFdvWei/maxFdvWei`).
///
/// Three contracts need this arithmetic and they MUST agree to the wei: `CurvePadFactoryV4` (which enforces the
/// band), `PresaleVault` and `ArrowLauncher` (which both size a curve buyout from the same start tick). A second
/// copy of either function is a divergence bug waiting to happen — the launcher would price the buy off one tick
/// while the factory initialized the pool at another — so both live here and nowhere else.
library PadValuation {
    /// @notice Resolve the launch tick: a per-launch `cfg.startTickMag` wins, 0 means "use the governed default".
    /// @dev 0 is a safe sentinel, not a magic value that collides with a real choice: the curve always launches at
    /// a POSITIVE tick magnitude (token = currency1, so the curve starts at the high tick and graduates downward),
    /// and the factory rejects `startMag <= 0` outright.
    function startTickOf(int24 cfgStartTickMag, int24 defaultStartTickMag) internal pure returns (int24) {
        return cfgStartTickMag == 0 ? defaultStartTickMag : cfgStartTickMag;
    }

    /// @notice Implied fully-diluted value, in WEI, of `supply` tokens at `startTick`.
    /// @dev currency0 is native ETH and currency1 is the pad token, so the pool price is TOKENS PER ETH:
    /// `P = (sqrtP / 2^96)^2`. One token is therefore worth `1/P` ETH and the whole supply is `supply / P`, i.e.
    /// `supply * 2^192 / sqrtP^2`. That is computed as TWO `mulDiv` steps rather than one, because `sqrtP^2`
    /// alone overflows uint256 above roughly tick 0 — the exact region every Robin curve launches in.
    /// A supply/price pair so extreme that even the 512-bit intermediate cannot land in uint256 reverts inside
    /// `mulDiv` rather than as `MarketCapOutOfRange`. That is a launch far outside any sane band either way, and
    /// it still fails closed before the factory writes a single byte of state.
    function fdvWei(uint256 supply, int24 startTick) internal pure returns (uint256) {
        uint256 sp = uint256(TickMath.getSqrtPriceAtTick(startTick));
        return FullMath.mulDiv(FullMath.mulDiv(supply, 1 << 96, sp), 1 << 96, sp);
    }
}
