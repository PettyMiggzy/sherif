// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";

/// @title RobinFloorVault — a permanent, fee-funded price floor
/// @notice A single-sided QUOTE (currency0) position placed just below the token's price: a standing
/// buy wall that catches sellers if the token dumps. It is fed by the pad's fee carve (the sell-tax
/// floor slice + optionally LP fees), and it is ADD-ONLY — there is deliberately NO remove/withdraw
/// path, so the wall can only ever deepen. That absence IS the "can't rug to zero" guarantee.
///
/// Not a vault-with-shares: nobody deposits, nobody redeems, no USDG is ever trapped. It simply turns
/// fee revenue into permanent, un-pullable price support. The vault manages its position as raw
/// liquidity inside its own `unlock` callback (no NFT), via exactly two ops — ADD and COLLECT — and
/// there is no code path that passes a negative liquidity delta.
///
/// Placement: the floor band sits in the pure-currency0 region ABOVE the current tick (in V4 a range
/// above spot holds 100% currency0). As the token price falls (tick rises into the band) the quote in
/// the wall automatically buys the token — that is the floor doing its job.
contract RobinFloorVault is IUnlockCallback, ReentrancyGuard {
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;

    enum Op {
        ADD,
        COLLECT
    }

    IPoolManager public immutable poolManager;
    IStateView public immutable stateView;
    address public immutable feeRecipient; // where collected floor LP fees go (platform)

    // the pool (stored as components; PoolKey is rebuilt in memory)
    Currency public immutable currency0; // quote
    Currency public immutable currency1; // token
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;

    int24 public immutable floorTickLower; // fixed band, set at deploy just above launch spot
    int24 public immutable floorTickUpper;

    uint128 public floorLiquidity; // total liquidity permanently locked in the wall (only grows)
    uint256 public parkedQuote; // carve received while spot is inside/below the band (added on recovery)

    event FloorAdded(uint256 quoteUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event FloorSkipped(int24 currentTick, uint256 parked);
    event FloorFeesCollected(uint256 amount0, uint256 amount1, address to);

    error NotPoolManager();
    error ZeroAddress();
    error BadBand();

    constructor(
        address poolManager_,
        address stateView_,
        address feeRecipient_,
        Currency currency0_,
        Currency currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        IHooks hooks_,
        uint24 bandWidthSpacings // how many tickSpacings wide the wall is (>=1)
    ) {
        if (poolManager_ == address(0) || stateView_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (bandWidthSpacings == 0) revert BadBand();
        poolManager = IPoolManager(poolManager_);
        stateView = IStateView(stateView_);
        feeRecipient = feeRecipient_;
        currency0 = currency0_;
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;

        // Place the band in the pure-currency0 region: the first spacing boundary strictly ABOVE spot.
        (, int24 tick,,) = IStateView(stateView_).getSlot0(_key(currency0_, currency1_, fee_, tickSpacing_, hooks_).toId());
        int24 lower = _alignUp(tick + 1, tickSpacing_);
        int24 upper = lower + int24(int256(uint256(bandWidthSpacings))) * tickSpacing_;
        if (upper > TickMath.maxUsableTick(tickSpacing_)) revert BadBand();
        floorTickLower = lower;
        floorTickUpper = upper;
    }

    /// @notice Deploy all on-hand quote (the carve) into the permanent wall. Permissionless. If spot
    /// has fallen into/below the band (so a single-sided currency0 add is not clean), the quote parks
    /// and is added on the next call once spot is back above the band.
    function addFloor() external nonReentrant returns (uint128 added) {
        uint256 amt = currency0.balanceOfSelf();
        if (amt == 0) return 0;
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        if (tick >= floorTickLower) {
            parkedQuote = amt;
            emit FloorSkipped(tick, amt);
            return 0;
        }
        added = abi.decode(poolManager.unlock(abi.encode(Op.ADD, amt)), (uint128));
    }

    /// @notice Collect the wall's accrued LP fees to the platform recipient. Never removes principal.
    function collectFloorFees() external nonReentrant {
        poolManager.unlock(abi.encode(Op.COLLECT, uint256(0)));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Op op, uint256 amt) = abi.decode(data, (Op, uint256));
        if (op == Op.ADD) return abi.encode(_add(amt));
        _collect();
        return "";
    }

    function _add(uint256 amt) internal returns (uint128 L) {
        uint160 sLower = TickMath.getSqrtPriceAtTick(floorTickLower);
        uint160 sUpper = TickMath.getSqrtPriceAtTick(floorTickUpper);
        L = LiquidityAmounts.getLiquidityForAmount0(sLower, sUpper, amt);
        if (L == 0) return 0;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({
                tickLower: floorTickLower,
                tickUpper: floorTickUpper,
                liquidityDelta: int256(uint256(L)), // ALWAYS positive — no remove path exists
                salt: bytes32(0)
            }),
            ""
        );
        _resolve(currency0, delta.amount0(), address(this));
        _resolve(currency1, delta.amount1(), address(this));
        floorLiquidity += L;
        parkedQuote = 0;
        emit FloorAdded(amt, L, floorLiquidity);
    }

    function _collect() internal {
        // a zero-liquidity poke realizes fees as a positive delta; take them to the platform
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: floorTickLower, tickUpper: floorTickUpper, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 > 0) poolManager.take(currency0, feeRecipient, uint256(uint128(a0)));
        if (a1 > 0) poolManager.take(currency1, feeRecipient, uint256(uint128(a1)));
        emit FloorFeesCollected(a0 > 0 ? uint256(uint128(a0)) : 0, a1 > 0 ? uint256(uint128(a1)) : 0, feeRecipient);
    }

    /// @dev Settle what the vault owes / take what it is owed for one currency.
    function _resolve(Currency currency, int128 amt, address takeTo) internal {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            if (currency.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                IERC20(Currency.unwrap(currency)).transfer(address(poolManager), owed);
                poolManager.settle();
            }
        } else if (amt > 0) {
            poolManager.take(currency, takeTo, uint256(uint128(amt)));
        }
    }

    function _alignUp(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 rounded = (tick / spacing) * spacing;
        if (rounded < tick) rounded += spacing; // ceil for positive remainder
        return rounded;
    }

    function _poolKey() internal view returns (PoolKey memory) {
        return _key(currency0, currency1, fee, tickSpacing, hooks);
    }

    function _key(Currency c0, Currency c1, uint24 f, int24 ts, IHooks h) internal pure returns (PoolKey memory) {
        return PoolKey({currency0: c0, currency1: c1, fee: f, tickSpacing: ts, hooks: h});
    }

    function _poolId() internal view returns (PoolId) {
        return _poolKey().toId();
    }

    receive() external payable {} // holds the native-ETH carve
}
