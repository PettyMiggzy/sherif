// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

interface IHookWeight {
    function onWeightChange(PoolId id, address user, uint256 newWeight) external;
}

/// @notice TEST-ONLY stand-in for Feature 2's DualStaking: the authorized per-pool weight
/// source. Lets unit tests drive the hook's O(1) holder accumulator directly.
contract MockWeightSource {
    IHookWeight public immutable hook;

    constructor(address hook_) {
        hook = IHookWeight(hook_);
    }

    function setWeight(PoolId id, address user, uint256 newWeight) external {
        hook.onWeightChange(id, user, newWeight);
    }
}
