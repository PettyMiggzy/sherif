// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The single seam that makes ETH / USDG / Stock quote assets uniform to the floor vault.
/// Every method that touches an external, possibly-pausable asset is expected to be best-effort at
/// the adapter boundary: a broken/paused quote's YIELD path must no-op (return 0), never revert the
/// vault. (Moving the quote itself through the pool is still subject to the quote's own pause — that
/// is inherent and disclosed; the adapter cannot fix core-level pauses.)
interface IQuoteAdapter {
    /// @return the quote ERC-20 (or address(0) for native ETH).
    function quote() external view returns (address);

    /// @return decimals of the quote asset (6 for USDG, 18 for ETH/stock).
    function quoteDecimals() external view returns (uint8);

    /// @notice Best-effort realize of any native yield on `holder`'s quote balance, folded by the
    /// caller. MUST NOT revert — return 0 if the yield source is frozen/paused/unset.
    /// @return gain the realized quote gain now sitting in `holder`'s balance (measured by the caller).
    function harvest(address holder) external returns (uint256 gain);
}
