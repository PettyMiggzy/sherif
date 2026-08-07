// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice The slice of the Uniswap V4 PositionManager (0x174c…2EFA) we actually call.
/// Defined locally so we don't transitively pull Permit2/solmate through the full periphery
/// IPositionManager (which breaks Hardhat's node-style import resolution). The real deployed
/// contract implements a superset of this; the selectors here match it exactly.
interface IPositionManagerMinimal {
    /// @notice Unlocks the PoolManager and executes the encoded (actions, params) batch.
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    /// @notice The tokenId that will be assigned to the NEXT minted position (starts at 1).
    /// Read before/after a MINT to learn the freshly-minted tokenId.
    function nextTokenId() external view returns (uint256);

    function ownerOf(uint256 tokenId) external view returns (address);
}
