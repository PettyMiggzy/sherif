// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RewardVault} from "../RewardVault.sol";

/// @notice Test-only stand-in for PadRouter: lets a test drive RewardVault.accrue (router-only) and captures
/// where donateFloor sends the swept remainder. Not deployed in production.
contract MockFloorRouter {
    RewardVault public vault;
    uint256 public donatedTotal;
    mapping(address => uint256) public donatedTo;

    function setVault(address v) external { vault = RewardVault(payable(v)); }

    function accrue(address coin, uint8 side) external payable {
        vault.accrue{value: msg.value}(coin, RewardVault.Side(side));
    }

    // RewardVault forwards the swept remainder here (this is where a coin's Bond floor lives in production).
    function donateFloor(address coin) external payable {
        donatedTotal += msg.value;
        donatedTo[coin] += msg.value;
    }

    receive() external payable {}
}
