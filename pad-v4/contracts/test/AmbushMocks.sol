// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Stand-in for RobinCurveV4. The ambush vault reads its band anchor from curve.gradTick() AND — since the
/// [M-26] fix — cross-checks its whole PoolKey against the curve, so this double must expose the same public
/// immutables the real curve does (currency0/currency1/fee/tickSpacing/hooks). Modelling only gradTick is what
/// let a vault be built against one pad's tick and another pad's pool.
contract MockCurveGrad {
    int24 public immutable gradTick;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable hooks;

    constructor(int24 g, address c0, address c1, uint24 f, int24 ts, address h) {
        gradTick = g;
        currency0 = c0;
        currency1 = c1;
        fee = f;
        tickSpacing = ts;
        hooks = h;
    }
}

/// @dev An ETH recipient that always reverts — used to prove the ambush's fee forwarding is non-bricking.
contract RevertingEthSink {
    receive() external payable {
        revert("no eth");
    }
}
