// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @title RobinStateView
/// @notice Read-only `extsload` wrapper bound to OUR PoolManager (0x8366 on Robinhood Chain).
/// No StateView on-chain pairs with that manager, so we deploy our own. Pure lens — zero trust
/// surface, no state, no owner. Used by the floor vault (`totalAssets`) and the indexer.
contract RobinStateView is StateView {
    constructor(IPoolManager _poolManager) StateView(_poolManager) {}
}
