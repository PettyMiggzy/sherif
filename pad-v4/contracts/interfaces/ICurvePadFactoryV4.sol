// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @dev Mirror of CurvePadFactoryV4.LaunchConfig — field-for-field so the ABI-encoded external call matches. Kept
/// standalone so the presale add-on depends only on public interfaces, never on the audited factory's source.
struct LaunchConfig {
    string name;
    string symbol;
    uint8 decimals;
    uint256 supply; // total minted to the factory (must == curveSupply + reserveSupply; no dev mint)
    uint256 curveSupply; // tokens sold via the single-sided curve
    uint256 reserveSupply; // tokens held back to pair the permanent LP + feed staking
    int24 tickSpacing;
    // [FDV] Creator-chosen launch price magnitude; 0 = use the governed default. Together with `supply` this
    // sets the implied valuation, which the factory bounds against RobinV4FeeConfig's FDV band.
    int24 startTickMag;
    address creator;
    // [NO-POOL] Creator's structural pad-type choice: true asks the factory to checkpoint at graduation instead
    // of fully exiting (see RobinCurveV4's noPoolForever). Reverts NoPoolForeverDisabled if the factory's
    // governed RobinV4FeeConfig hasn't opted the pad type in yet.
    bool noPoolForever;
    // [LP-FEE] The creator's OWN choice of the pool's static Uniswap v4 LP fee (pips; 0 = free, no implicit
    // "0 means use the default" sentinel — this field is always read literally). Bounded to
    // [0, RobinV4FeeConfig.MAX_LP_FEE()] and rejected if it carries the dynamic-fee flag, same as every other
    // lpFee check in this codebase. This is the ONE economic knob this struct hands to the caller — every other
    // field stays governed-only (see CurvePadFactoryV4's GOVERNANCE doc comment) because this is a second,
    // genuinely separate take on top of the buy/sell tax (per RobinV4FeeConfig's own M-10 note), not the tax
    // itself, and letting the creator pick it (down to 0%, if they want a coin with no LP take at all) doesn't
    // weaken "a launcher can never set their own tax." Appended last so this stays ABI-compatible with every
    // existing encoder of this struct.
    uint24 lpFee;
    // [AUCTION] Optional 0-4 day pre-launch daily batch auction, parity with launchpad's (v3) DailyAuctionVault.
    // 0 = no auction (the default; every existing encoder of this struct is unaffected). 1-4 = that many days;
    // the factory carves `auctionDays * 10%` of `curveSupply` out BEFORE seeding the curve and hands it to a new
    // DailyAuctionVaultV4. Reverts BadConfig above 4, or if the deployment hasn't wired an auctionVaultDeployer.
    // Appended last, after lpFee, so this stays ABI-compatible with every existing encoder of this struct.
    uint8 auctionDays;
}

/// @notice The thin slice of CurvePadFactoryV4 the presale add-on consumes. `launch` is externally callable by any
/// address (the presale vault becomes msg.sender and buys via the same public PoolManager path any trader uses).
interface ICurvePadFactoryV4 {
    function launch(LaunchConfig calldata cfg, bytes32 tokenSalt, bytes32 hookSalt, bytes32 curveSalt)
        external
        returns (address token, address hook, address curve, PoolId poolId);
    function feeConfig() external view returns (address);
    function feeRegistry() external view returns (address);
    function poolManager() external view returns (address);
    function stateView() external view returns (address);
}
