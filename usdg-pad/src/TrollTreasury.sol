// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Shared across every launch, on every pad (the original and every
/// TrollPadFactory white-label one): every launch's platform cut lands here
/// once its splitter's `claimPlatform` is called. No automated swap, no
/// automated burn, no keeper of any kind. What happens to this balance
/// (buying back $TROLL, or anything else) is a deliberate, manual, human
/// decision made by whoever holds `owner`, on whatever cadence they want.
///
/// Deliberately not a "buyback-and-burn" contract: an earlier version of
/// this repo auto-swapped and burned on every deposit, but that adds real
/// complexity and risk (a live price read for slippage protection, a
/// dependency on Arc's UniversalRouter/Permit2/StateView addresses being
/// exactly right, an unsupervised swap running on every single trade) for
/// a feature nobody asked to keep — if holders want to burn their own
/// tokens, they can do that themselves.
contract TrollTreasury {
    using SafeERC20 for IERC20;

    address public owner;
    address public pendingOwner;

    error NotOwner();
    error ZeroAddress();
    error NativeTransferFailed();

    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnerTransferStarted(address indexed from, address indexed to);
    event OwnerTransferred(address indexed from, address indexed to);

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    /// @notice Arc's gas is USDC-denominated native currency — accept it
    /// directly (audit finding L-7: without this, native value sent here
    /// has no way in and is simply lost).
    receive() external payable {}

    /// @notice Sends `amount` of `token` to `to`. `token == address(0)`
    /// withdraws native currency instead of an ERC-20. Callable only by
    /// `owner`. No other function exists on this contract — no swap, no
    /// burn, no automatic trigger of any kind.
    function withdraw(address token, address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Withdrawn(token, to, amount);
    }

    /// @notice Two-step owner handover — the only recovery path for a lost
    /// owner key is rotating it BEFORE it's lost (audit finding M-4: this
    /// key gates every dollar of platform revenue across every pad, so
    /// losing it with no rotation path would strand all of it forever).
    function transferOwner(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = newOwner;
        emit OwnerTransferStarted(owner, newOwner);
    }

    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnerTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
