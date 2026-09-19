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
/// The trade tax routes by DIRECTION ([L-5] both taxes are money-side; the buy tax is a fee-on-INPUT, not on output):
///   • BUY  (spend quote → get token): `buyTaxBps` of the quote INPUT → platform (+ curve buffer)
///   • SELL (spend token → get quote): `sellTaxBps` of the quote output → creator + floor,
///          where `sellFloorShareBps` of that sell tax is carved to the floor (out of the creator's cut).
interface IRobinFeeHookAdmin {
    struct PoolFeeConfig {
        Currency currency0; // quote (native ETH / USDG / stock)
        Currency currency1; // the launched token
        address creator; // receives the sell tax (less the floor carve)
        address floorRecipient; // receives the floor carve; address(0) => it parks in floorOwed
        address guardAdapter; // stock guard; address(0) => no curb
        uint16 buyTaxBps; // tax on buys → platform + curve buffer (fee-on-input, bps of the money-side input)
        uint16 sellTaxBps; // tax on sells → creator + floor (bps of the money-side output)
        uint16 sellFloorShareBps; // share of the SELL tax carved to the floor (bps of the sell fee)
        uint16 buyBufferShareBps; // share of the BUY tax kept as a curve buffer (rest → platform); money side
        uint16 referralShareBps; // share of the PLATFORM buy cut paid to a referrer passed in swap hookData; money side
        uint32 guardWindow; // seconds around a scheduled stock action; 0 => no curb
        bool quoteIsStock;
    }

    function registerPool(PoolId id, PoolFeeConfig calldata cfg) external;
}

/// @notice [H-5] The floor gate surface the hook exposes and `RobinFloorVault` reads.
/// Every return is a FLAT single 32-byte word (uint256/int256) so the vault's `abi.decode` can never revert on a
/// dirty word — the failure mode a packed `(bool,int24,uint40)` tuple would introduce in the CALLER's frame. The
/// vault always reads these through a low-level `staticcall` + length check, so an unarmed hook, an EOA, a hook
/// from an older build, or a short/garbage return all degrade to "park", never to a revert.
interface IRobinFloorGate {
    /// @return armedAt      unix time `armFloorGate` bound this pool's band (0 = never armed)
    /// @return aboveLowerTs last second a swap's PRE-swap tick was >= the band's lower tick (THE GATE)
    /// @return aboveUpperTs last second a swap's PRE-swap tick was >= the band's upper tick (diagnostics)
    /// @return gateLower    the band lower tick the hook is armed for — the vault cross-checks its own
    function floorGateState(PoolId id)
        external
        view
        returns (uint256 armedAt, uint256 aboveLowerTs, uint256 aboveUpperTs, int256 gateLower);

    /// @return the arithmetic-mean tick over `window` seconds, or `type(int256).max` when unavailable
    function consultTick(PoolId id, uint32 window) external view returns (int256);
}

/// @notice [H-5] The band surface `RobinFeeHook.armFloorGate` reads back off a floor vault, so arming can hard-revert
/// on a mis-wired pair instead of silently arming the hook for a band no vault owns.
interface IRobinFloorBand {
    function floorTickLower() external view returns (int24);
    function floorTickUpper() external view returns (int24);
    function poolId() external view returns (PoolId);
}
