// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  Disperse — stateless one-transaction multisend
/// @notice Sends ETH to many recipients in a SINGLE transaction. It holds no
///         funds between calls: you send the total as msg.value and it fans it
///         out in the same tx; any excess is refunded to you. This is the cheap,
///         repeatable path — for wallets that already exist on-chain a batch
///         costs ~10k gas/recipient (vs 21k for individual sends), and ~1000 of
///         them fit under Robinhood Chain's 2^24 (16,777,216) per-tx gas cap.
///
///         (First-ever payment to a brand-new wallet costs ~25k more for account
///         creation regardless of method — so the very first round is cheaper as
///         individual sends; every round after is cheapest here. The watcher
///         picks the batch size automatically.)
contract Disperse {
    /// @notice Pay `amountEach` wei to every recipient in one tx.
    /// @dev msg.value must be >= amountEach * recipients.length; excess refunded.
    function disperseEqual(address[] calldata recipients, uint256 amountEach) external payable {
        uint256 n = recipients.length;
        uint256 total = amountEach * n;
        require(msg.value >= total, "insufficient value");
        for (uint256 i = 0; i < n; ) {
            (bool ok, ) = recipients[i].call{value: amountEach}("");
            require(ok, "send failed");
            unchecked { ++i; }
        }
        uint256 refund = msg.value - total;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
    }

    /// @notice Variable-amount variant: `amounts[i]` wei to `recipients[i]`.
    function disperse(address[] calldata recipients, uint256[] calldata amounts) external payable {
        uint256 n = recipients.length;
        require(amounts.length == n, "length mismatch");
        uint256 total;
        for (uint256 i = 0; i < n; ) { total += amounts[i]; unchecked { ++i; } }
        require(msg.value >= total, "insufficient value");
        for (uint256 i = 0; i < n; ) {
            (bool ok, ) = recipients[i].call{value: amounts[i]}("");
            require(ok, "send failed");
            unchecked { ++i; }
        }
        uint256 refund = msg.value - total;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
    }
}
