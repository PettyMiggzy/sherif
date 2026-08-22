// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BondGeometry} from "../BondGeometry.sol";

/// @notice Test-only reader for the shipped wall band. `BondGeometry` is a library of constants with no runtime
/// surface, so a test cannot see it without something like this — and asserting the shipped numbers from a test
/// is worth more than trusting a comment, because these two integers ARE the H-5 fix.
contract BondGeometryProbe {
    function near() external pure returns (int24) { return BondGeometry.BOUNTY_NEAR; }
    function far() external pure returns (int24) { return BondGeometry.BOUNTY_FAR; }
}
