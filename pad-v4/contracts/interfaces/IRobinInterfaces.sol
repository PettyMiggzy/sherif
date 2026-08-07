// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @notice The single mutable knob in the whole system. The hook reads
/// `platformFeeWallet()` at accrual/claim time (forward-only); the registry
/// moves it only via Ownable2Step owner + a 2-day timelock.
interface IFeeWalletRegistry {
    function platformFeeWallet() external view returns (address);
}

/// @notice Stock adapter surface the hook needs for the §3.4 corporate-action curb.
/// Every call the hook makes to an adapter is try/catch-wrapped so a broken adapter
/// can never brick a swap — a revert is read as "no scheduled action".
interface IStockGuardAdapter {
    /// @return effectiveAt unix time a scheduled corporate action takes effect, or 0 if none.
    function scheduledEffectiveAt() external view returns (uint256 effectiveAt);
}

/// @notice The per-pool weight source for the O(1) holder accumulator. In Feature 1
/// this is unset (holder cuts park); in Feature 2 it is the pool's DualStaking, which
/// calls `onWeightChange` on every stake/unstake so the hook can checkpoint rewards.
interface IHolderWeightSource {
    function totalHolderWeight(PoolId id) external view returns (uint256);
}

/// @notice Minimal registration surface the factory calls on the hook in the launch tx.
interface IRobinFeeHookAdmin {
    struct PoolFeeConfig {
        Currency currency0;
        Currency currency1;
        address creator;
        address weightSource; // DualStaking; address(0) => holder cut parks
        address guardAdapter; // stock guard; address(0) => no curb
        uint16 feeBps; // fee as bps of the swap's output (unspecified) leg
        uint16 platformShareBps; // share of the fee to platform
        uint16 creatorShareBps; // share of the fee to creator; holder = remainder
        uint32 guardWindow; // seconds around a scheduled stock action; 0 => no curb
        bool quoteIsStock;
    }

    function registerPool(PoolId id, PoolFeeConfig calldata cfg) external;
}
