// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The one Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3) call the factory makes
/// so the PositionManager can pull the seed tokens during SETTLE_PAIR. Defined locally to avoid
/// pulling the full permit2 source tree through Hardhat's resolver.
interface IPermit2Minimal {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
