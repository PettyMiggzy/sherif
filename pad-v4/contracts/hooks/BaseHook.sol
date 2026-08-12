// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title BaseHook
/// @notice Minimal, dependency-light base for the Robin V4 hooks. Three jobs:
///   1. Pin the hook's permission flags into a public constant AND self-assert
///      them in the constructor, so a hook deployed to a wrong-flag address
///      reverts at deploy time instead of silently mis-behaving. The factory
///      cross-checks `REQUIRED_FLAGS` against the mined address independently.
///   2. Gate every PoolManager callback behind `onlyPoolManager`.
///   3. Provide a transient-storage reentrancy guard (cheaper than SSTORE and
///      re-entry-during-send safe) used on the state-bearing entry points.
///
/// All IHooks callbacks are stubbed to revert here; RobinFeeHook overrides only
/// the flagged ones (beforeSwap / afterSwap). An unflagged callback is never
/// invoked by the PoolManager, so the revert is a belt-and-suspenders guard.
abstract contract BaseHook is IHooks {
    /// @notice The one-and-only mining target: BEFORE_SWAP(0x80) | AFTER_SWAP(0x40) |
    /// BEFORE_SWAP_RETURNS_DELTA(0x08) | AFTER_SWAP_RETURNS_DELTA(0x04) == 0x00CC. The two RETURNS_DELTA flags
    /// are both required: the buy fee is settled via a beforeSwap specified delta, the sell fee via afterSwap.
    /// Public so the factory can require(hook.REQUIRED_FLAGS() == expected) and so the
    /// address miner and the ctor self-assert all read the same source of truth.
    uint160 public constant REQUIRED_FLAGS = 0x00CC;
    /// @dev Low 14 bits are the hook-permission field the PoolManager reads from the address.
    uint160 internal constant ALL_HOOK_MASK = 0x3FFF;

    IPoolManager public immutable poolManager;

    /// @dev Fixed transient slot for the reentrancy flag. Arbitrary high slot; tstore/tload.
    bytes32 private constant REENTRANCY_SLOT = 0x8b6b7f8e9c0a1b2c3d4e5f60718293a4b5c6d7e8f90102030405060708090a0b;

    error NotPoolManager();
    error HookAddressFlagsMismatch();
    error HookNotImplemented();
    error Reentrancy();

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
        // Self-assert: this contract's own address must carry EXACTLY our flags in its low 14 bits.
        // CREATE2 salt is mined off-chain so the deployed address satisfies this; if it does not,
        // deployment reverts here and no mis-flagged hook can ever exist.
        if (uint160(address(this)) & ALL_HOOK_MASK != REQUIRED_FLAGS) revert HookAddressFlagsMismatch();
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier nonReentrant() {
        assembly ("memory-safe") {
            if tload(REENTRANCY_SLOT) {
                mstore(0x00, 0xab143c06) // Reentrancy()
                revert(0x1c, 0x04)
            }
            tstore(REENTRANCY_SLOT, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(REENTRANCY_SLOT, 0)
        }
    }

    // --- IHooks: default-revert stubs. RobinFeeHook overrides beforeSwap / afterSwap. ---

    function beforeInitialize(address, PoolKey calldata, uint160) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external virtual returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        virtual
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        virtual
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external virtual returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        virtual
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        virtual
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        virtual
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        virtual
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
