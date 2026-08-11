// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Minimal stand-in for RobinCurveV4: the ambush vault reads its band anchor from curve.gradTick().
contract MockCurveGrad {
    int24 public immutable gradTick;

    constructor(int24 g) {
        gradTick = g;
    }
}

/// @dev An ETH recipient that always reverts — used to prove the ambush's fee forwarding is non-bricking.
contract RevertingEthSink {
    receive() external payable {
        revert("no eth");
    }
}
