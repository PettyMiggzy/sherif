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
}

/// @notice The thin slice of CurvePadFactoryV4 the presale add-on consumes. `launch` is externally callable by any
/// address (the presale vault becomes msg.sender and buys via the same public PoolManager path any trader uses).
interface ICurvePadFactoryV4 {
    function launch(LaunchConfig calldata cfg, bytes32 tokenSalt, bytes32 hookSalt, bytes32 curveSalt)
        external
        returns (address token, address hook, address curve, PoolId poolId);
    function feeConfig() external view returns (address);
    function poolManager() external view returns (address);
    function stateView() external view returns (address);
}
