// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Stand-in for a CurvePool in router unit tests: exposes a settable bond() so we can simulate a coin
/// graduating (bond != 0) and exercise the deferred-fee release / floor flush paths.
contract MockCurve {
    address public bond;

    function setBond(address b) external {
        bond = b;
    }
}
