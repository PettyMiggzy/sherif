// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockPermit2 — the tiny slice of Permit2 AllowanceTransfer the curve/posm path exercises.
/// @notice TEST-ONLY. The real Permit2 is pinned to solc 0.8.17 and drags in solmate, so it can't compile under
/// this repo's 0.8.26/viaIR config. This mock implements exactly the two calls used at graduation:
///   • approve(token, spender, amount, expiration) — the curve authorizes the PositionManager to pull `amount`,
///   • transferFrom(from, to, amount, token) — the PositionManager pulls the seed token during SETTLE_PAIR,
/// backed by a normal ERC20 allowance (curve → this Permit2), matching the real contract's behavior.
contract MockPermit2 {
    struct Allow {
        uint160 amount;
        uint48 expiration;
    }

    // allowance[owner][token][spender]
    mapping(address => mapping(address => mapping(address => Allow))) public allowance;

    error InsufficientAllowance();

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allow(amount, expiration);
    }

    /// @notice Spender (the PositionManager) pulls `amount` of `token` from `from` to `to`, consuming the
    /// caller's Permit2 allowance and the underlying ERC20 allowance (from → this contract).
    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allow storage a = allowance[from][token][msg.sender];
        if (a.amount < amount) revert InsufficientAllowance();
        if (a.amount != type(uint160).max) a.amount -= amount;
        IERC20(token).transferFrom(from, to, amount);
    }
}
