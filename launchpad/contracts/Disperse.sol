// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Disperse
/// @notice Send native ETH or an ERC20 to many recipients in a single transaction.
///
/// Non-custodial by design: the contract stores nothing and holds no balance
/// between calls. It has no owner, no upgrade path, no admin — there is nothing
/// to pause, drain, or rug. Every call fans a caller's own funds out to the
/// caller's own list, all-or-nothing (any failed leg reverts the whole tx).
///
/// - `disperseTokenDirect` is the primary path: it moves tokens straight from the
///   sender to each recipient via `transferFrom`, so funds NEVER touch this
///   contract. Safe for fee-on-transfer tokens and the cheapest to reason about.
/// - `disperseToken` pulls the sum once then pays each recipient (one extra hop);
///   kept for callers who prefer a single incoming transfer. NOT for
///   fee-on-transfer tokens (the contract would receive less than the sum).
/// - `disperseEther` fans out `msg.value`; any excess over the summed amounts is
///   refunded to the sender in the same tx.
///
/// Token paths require the sender to `approve` this contract for the summed
/// amount first (standard ERC20 allowance).
contract Disperse is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// A sane upper bound so a single call can't be built to run out of gas in a
    /// way that wastes a signature; callers batch larger lists across txs.
    uint256 public constant MAX_RECIPIENTS = 600;

    error LengthMismatch();
    error EmptyList();
    error TooManyRecipients();
    error ValueMismatch(); // msg.value < sum(values)
    error EthTransferFailed();

    /// @notice Send `values[i]` of native ETH to `recipients[i]`. Sum(values) must
    /// be <= msg.value; any remainder is refunded to msg.sender.
    function disperseEther(address[] calldata recipients, uint256[] calldata values)
        external
        payable
        nonReentrant
    {
        uint256 n = recipients.length;
        if (n != values.length) revert LengthMismatch();
        if (n == 0) revert EmptyList();
        if (n > MAX_RECIPIENTS) revert TooManyRecipients();

        uint256 total;
        for (uint256 i; i < n; ++i) total += values[i];
        if (msg.value < total) revert ValueMismatch();

        for (uint256 i; i < n; ++i) {
            (bool ok, ) = recipients[i].call{value: values[i]}("");
            if (!ok) revert EthTransferFailed();
        }

        uint256 refund = msg.value - total;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    /// @notice Move `values[i]` of `token` straight from msg.sender to
    /// `recipients[i]` (funds never touch this contract). Requires an allowance
    /// of sum(values) to this contract. Safe for fee-on-transfer tokens.
    function disperseTokenDirect(IERC20 token, address[] calldata recipients, uint256[] calldata values)
        external
        nonReentrant
    {
        uint256 n = recipients.length;
        if (n != values.length) revert LengthMismatch();
        if (n == 0) revert EmptyList();
        if (n > MAX_RECIPIENTS) revert TooManyRecipients();

        for (uint256 i; i < n; ++i) {
            token.safeTransferFrom(msg.sender, recipients[i], values[i]);
        }
    }

    /// @notice Pull sum(values) of `token` from msg.sender once, then pay each
    /// recipient. NOT for fee-on-transfer tokens. Requires an allowance of
    /// sum(values) to this contract.
    function disperseToken(IERC20 token, address[] calldata recipients, uint256[] calldata values)
        external
        nonReentrant
    {
        uint256 n = recipients.length;
        if (n != values.length) revert LengthMismatch();
        if (n == 0) revert EmptyList();
        if (n > MAX_RECIPIENTS) revert TooManyRecipients();

        uint256 total;
        for (uint256 i; i < n; ++i) total += values[i];
        token.safeTransferFrom(msg.sender, address(this), total);
        for (uint256 i; i < n; ++i) {
            token.safeTransfer(recipients[i], values[i]);
        }
    }
}
