// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RobinStaking} from "../pads/RobinStaking.sol";
import {DailyAuctionVaultV4} from "../pads/DailyAuctionVaultV4.sol";

/// @notice Thin deployers so RobinStaking's and DailyAuctionVaultV4's creation bytecode isn't inlined into
/// CurvePadFactoryV4 (24KB contract-size limit, same reasoning as CurveV4Deployer for RobinCurveV4) — and, for
/// RobinStaking specifically, so it isn't inlined into DailyAuctionVaultV4 either. v3's DailyAuctionVault learned
/// this the hard way: a `new RobinStaking(...)` called directly inside it inlined ~8.6KB of RobinStaking's own
/// creation bytecode into DailyAuctionVault's deployed bytecode, and combined with an already gas-heavy launch
/// transaction, pushed every auction-enabled launch over Robinhood Chain's real per-tx gas cap. Applied here
/// proactively rather than discovering it again.

contract RobinStakingV4Deployer {
    function deploy(address stakeToken, address owner) external returns (address) {
        return address(new RobinStaking(stakeToken, owner));
    }
}

contract DailyAuctionVaultV4Deployer {
    /// @notice Shared across every vault this deployer creates — baked in at ITS OWN construction (like v3's
    /// DailyAuctionVaultDeployer bakes in its robinStakingDeployer) so CurvePadFactoryV4's own deploy-call shape
    /// never needs to change if the staking-deployer wiring ever does.
    address public immutable robinStakingDeployer;

    constructor(address robinStakingDeployer_) {
        robinStakingDeployer = robinStakingDeployer_;
    }

    function deploy(
        address token,
        address poolManager,
        address curve,
        address feeRegistry,
        uint8 auctionDays,
        uint256 auctionAmt
    ) external returns (address) {
        return address(
            new DailyAuctionVaultV4(token, poolManager, curve, feeRegistry, robinStakingDeployer, auctionDays, auctionAmt)
        );
    }
}
