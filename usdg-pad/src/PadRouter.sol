// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The v4-core that v4-periphery's V4Router is built against (its own pinned
// copy, see remappings.txt), not the top-level one the pad's other contracts
// use: V4Router needs a newer v4-core (types/PoolOperation.sol). The router
// only talks to the PoolManager and the pad over ABI calls, which both
// versions share.
import {IPoolManager} from "v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-periphery/lib/v4-core/src/types/Currency.sol";
import {SafeCast} from "v4-periphery/lib/v4-core/src/libraries/SafeCast.sol";
import {V4Router} from "@uniswap/v4-periphery/src/V4Router.sol";
import {ReentrancyLock} from "@uniswap/v4-periphery/src/base/ReentrancyLock.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

/// @notice Swap router for chains where Uniswap's UniversalRouter isn't
/// deployed. It speaks the UniversalRouter's interface for the one command
/// the pad uses — `execute(commands, inputs, deadline)` with V4_SWAP (0x10)
/// — so the site's swap and quote code works unchanged against either.
///
/// The swap logic is Uniswap's own V4Router (v4-periphery, pinned in
/// foundry.lock): each V4_SWAP input is the same `abi.encode(actions,
/// params)` payload the UniversalRouter hands to it. Payment works the same
/// way too: tokens are pulled from the caller through Permit2 (the caller
/// grants this router a Permit2 allowance), straight into the PoolManager.
///
/// No owner, no fees, no state: between calls the router holds nothing.
/// The reentrancy lock records the caller, and that caller is the only
/// address V4Router will pull payment from (`msgSender()`).
contract PadRouter is V4Router, ReentrancyLock {
    using SafeCast for uint256;

    /// @notice UniversalRouter's command id for a v4 swap.
    uint256 public constant V4_SWAP = 0x10;
    /// @dev UniversalRouter's command layout: low 6 bits are the command type,
    /// the top bit allows a failed command to be skipped (not supported here).
    uint256 internal constant COMMAND_TYPE_MASK = 0x3f;

    IAllowanceTransfer public immutable permit2;

    error TransactionDeadlinePassed();
    error LengthMismatch();
    error InvalidCommandType(uint256 commandType);

    constructor(IPoolManager poolManager_, IAllowanceTransfer permit2_) V4Router(poolManager_) {
        permit2 = permit2_;
    }

    /// @notice UniversalRouter-compatible entry point. Only V4_SWAP commands
    /// are accepted; anything else reverts. Not payable: pools on the pad are
    /// ERC-20 on both sides, so native currency sent here could only get stuck.
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external isNotLocked {
        if (block.timestamp > deadline) revert TransactionDeadlinePassed();
        if (commands.length != inputs.length) revert LengthMismatch();
        for (uint256 i; i < commands.length; i++) {
            uint256 command = uint8(commands[i]);
            if (command != V4_SWAP) revert InvalidCommandType(command & COMMAND_TYPE_MASK);
            _executeActions(inputs[i]);
        }
    }

    /// @notice The address swaps are paid from and delivered to: whoever
    /// called `execute` (recorded by the reentrancy lock).
    function msgSender() public view override returns (address) {
        return _getLocker();
    }

    /// @dev Pays the PoolManager: from this contract's own balance when the
    /// action says so (never the case for the site's swaps, and the router
    /// keeps no balance), otherwise from the caller through Permit2.
    function _pay(Currency token, address payer, uint256 amount) internal override {
        if (payer == address(this)) {
            token.transfer(address(poolManager), amount);
        } else {
            permit2.transferFrom(payer, address(poolManager), amount.toUint160(), Currency.unwrap(token));
        }
    }
}
