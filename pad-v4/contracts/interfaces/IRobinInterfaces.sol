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

/// @notice Minimal registration surface the factory calls on the hook in the launch tx.
/// The trade tax routes by DIRECTION:
///   • BUY  (spend quote → get token): `buyTaxBps` of the token output → platform
///   • SELL (spend token → get quote): `sellTaxBps` of the quote output → creator + floor,
///          where `sellFloorShareBps` of that sell tax is carved to the floor (out of the creator's cut).
interface IRobinFeeHookAdmin {
    struct PoolFeeConfig {
        Currency currency0; // quote (native ETH / USDG / stock)
        Currency currency1; // the launched token
        address creator; // receives the sell tax (less the floor carve)
        address floorRecipient; // receives the floor carve; address(0) => it parks in floorOwed
        address guardAdapter; // stock guard; address(0) => no curb
        uint16 buyTaxBps; // tax on buys → platform + curve buffer (bps of token output)
        uint16 sellTaxBps; // tax on sells → creator + floor (bps of quote output)
        uint16 sellFloorShareBps; // share of the SELL tax carved to the floor (bps of the sell fee)
        uint16 buyBufferShareBps; // share of the BUY tax kept as a curve buffer (rest → platform); token leg
        uint16 referralShareBps; // share of the PLATFORM buy cut paid to a referrer passed in swap hookData (token leg)
        uint32 guardWindow; // seconds around a scheduled stock action; 0 => no curb
        bool quoteIsStock;
    }

    function registerPool(PoolId id, PoolFeeConfig calldata cfg) external;
}
