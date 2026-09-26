// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITrollSplitter {
    /// @notice Splits `amount` of `quoteAsset` (already transferred to the
    /// splitter by the caller) into platform and creator credits — nothing
    /// is pushed out. See TrollRevenueSplitter for the exact ratio.
    function depositRevenue(address quoteAsset, uint256 amount) external;

    /// @notice Pays the creator's accrued `quoteAsset` balance to `to`.
    /// Callable only by the creator.
    function claim(address to, address quoteAsset) external;

    /// @notice Pays the platform's accrued `quoteAsset` balance to the
    /// treasury. Callable by anyone — pull-based so a blocklisted or
    /// otherwise broken treasury can only ever block its own claim.
    function claimPlatform(address quoteAsset) external;
}
