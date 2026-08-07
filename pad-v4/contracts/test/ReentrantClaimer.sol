// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

interface IHookClaim {
    function claimHolder(PoolId id, uint256 currencyIndex) external returns (uint256);
}

/// @notice TEST-ONLY: on receiving native ETH it re-enters claimHolder, to prove the hook's
/// nonReentrant guard blocks a reentrancy attack from a reward recipient.
contract ReentrantClaimer {
    IHookClaim public immutable hook;
    PoolId public id;
    uint256 public idx;
    bool public armed;

    constructor(address hook_) {
        hook = IHookClaim(hook_);
    }

    function arm(PoolId id_, uint256 idx_) external {
        id = id_;
        idx = idx_;
        armed = true;
    }

    function claim() external returns (uint256) {
        return hook.claimHolder(id, idx);
    }

    receive() external payable {
        if (armed) {
            armed = false; // one shot; the re-entrant call should revert and bubble up
            hook.claimHolder(id, idx);
        }
    }
}
