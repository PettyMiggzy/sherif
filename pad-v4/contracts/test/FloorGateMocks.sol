// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// TEST-ONLY mocks for [H-5] `RobinFloorVault._gateState` / `_twap`. Each one is a hostile hook stand-in that
/// answers `floorGateState` / `consultTick` in a way that MUST resolve to "park", never to a revert in the
/// vault's frame. The vault reads both through a low-level staticcall + length check precisely so these can't
/// brick the honest path.

/// Answers every selector with zero bytes — the classic short return that a bare `try/catch` does NOT absorb,
/// because the caller's `abi.decode` runs after the call already succeeded.
contract GateShortReturner {
    fallback() external payable {
        assembly {
            return(0, 0)
        }
    }
    receive() external payable {}
}

/// Returns the right LENGTH but garbage content: `armedAt` far beyond uint64 and a gateLower that is not this
/// vault's band. Both must be rejected by `_gateState`'s range and cross-checks.
contract GateDirtyReturner {
    fallback() external payable {
        assembly {
            mstore(0x00, not(0)) // armedAt = type(uint256).max
            mstore(0x20, not(0)) // aboveLowerTs
            mstore(0x40, not(0)) // aboveUpperTs
            mstore(0x60, 12345) // gateLower — not the vault's floorTickLower
            return(0x00, 0x80)
        }
    }
    receive() external payable {}
}

/// Reverts on every call. The vault must read this as "park", never propagate it.
contract GateReverter {
    fallback() external payable {
        revert("nope");
    }
    receive() external payable {}
}

/// A platform "wallet" that swaps the tick INTO the band while it is being paid, exercising the [H-5/P3]
/// re-entrancy window: `_collect` does `poolManager.take(currency0, plat, …)`, and for native ETH that
/// forwards full gas while the PoolManager is unlocked. The vault must abort the mint cleanly (no revert).
contract TickMovingPlatform {
    IPoolManager public immutable poolManager;
    PoolKey public key;
    uint160 public limit;
    bool public armed;
    bool public fired;

    constructor(address pm_) {
        poolManager = IPoolManager(pm_);
    }

    function arm(PoolKey calldata k, uint160 sqrtLimit) external {
        key = k;
        limit = sqrtLimit;
        armed = true;
        fired = false;
    }

    receive() external payable {
        if (!armed || fired) return;
        fired = true;
        // best-effort: the PoolManager is already unlocked by the vault, so swap directly
        try poolManager.swap(
            key, SwapParams({zeroForOne: false, amountSpecified: -1e21, sqrtPriceLimitX96: limit}), ""
        ) {} catch {}
    }
}
