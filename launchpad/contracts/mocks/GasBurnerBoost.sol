// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev A boost source that eats every drop of gas it is handed. Used to prove `qualifiesForBoost` cannot be
/// used to brick a stake or a withdrawal.
contract GasBurnerBoost {
    uint256 public sink;
    function stakedOf(address) external returns (uint256) {
        while (true) { sink++; }
        return 0;
    }
}
