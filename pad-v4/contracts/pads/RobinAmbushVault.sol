// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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

/// @title RobinAmbushVault — a permanent, passive token sell-wall that supports the floor
/// @notice The mirror of RobinFloorVault. Where the floor is a single-sided QUOTE (currency0) BUY wall placed
/// just ABOVE spot that catches dumps, the ambush is a single-sided TOKEN (currency1) SELL wall placed just
/// BELOW the graduation price. It is seeded at graduation from a held-back token allotment (the "unsold tokens
/// that go there so it can support the project"). As the token PUMPS (buys push the tick DOWN into the band),
/// the wall automatically sells token for ETH — a passive cap on runaway pumps — and the LP fees it earns are
/// swept to the permanent floor, so the pump's own volume deepens the rug-proof floor.
///
/// It is ADD-ONLY: there is deliberately NO remove/withdraw path, exactly like the floor, so the wall can only
/// ever deepen and can never be pulled. It is PASSIVE and UN-GAMEABLE — it never chases price, quotes on a
/// schedule, or reads an oracle; it is a fixed band of liquidity that the market trades against on its own terms.
///
/// Placement: in V4 a range ENTIRELY BELOW spot (currentTick ≥ tickUpper) holds 100% currency1 (token). So the
/// band sits just under the launch/graduation tick; a pump that pushes the tick down into it converts the token
/// into ETH — that is the ambush doing its job. Managed as raw liquidity inside its own `unlock` callback (no
/// NFT), via exactly two ops — ADD and COLLECT — with no code path that passes a negative liquidity delta.
contract RobinAmbushVault is IUnlockCallback, ReentrancyGuard {
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;

    enum Op {
        ADD,
        COLLECT
    }

    IPoolManager public immutable poolManager;
    IStateView public immutable stateView;
    address public immutable floorRecipient; // the RobinFloorVault — ETH (currency0) LP fees are swept here

    // the pool (stored as components; PoolKey is rebuilt in memory)
    Currency public immutable currency0; // quote (ETH)
    Currency public immutable currency1; // token
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;

    int24 public immutable ambushTickLower; // fixed band, set at deploy just BELOW launch/graduation spot
    int24 public immutable ambushTickUpper;

    uint128 public ambushLiquidity; // total liquidity permanently locked in the wall (only grows)
    uint256 public parkedToken; // token received while spot is inside/below the band (added on recovery)

    event AmbushAdded(uint256 tokenUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event AmbushSkipped(int24 currentTick, uint256 parked);
    event AmbushFeesCollected(uint256 ethToFloor, uint256 tokenReparked);

    error NotPoolManager();
    error ZeroAddress();
    error BadBand();

    constructor(
        address poolManager_,
        address stateView_,
        address floorRecipient_,
        Currency currency0_,
        Currency currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        IHooks hooks_,
        int24 anchorTick, // the pad's graduation tick — the band anchors here, NOT to live spot
        uint24 bandWidthSpacings // how many tickSpacings wide the wall is (>=1)
    ) {
        if (poolManager_ == address(0) || stateView_ == address(0) || floorRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (bandWidthSpacings == 0) revert BadBand();
        poolManager = IPoolManager(poolManager_);
        stateView = IStateView(stateView_);
        floorRecipient = floorRecipient_;
        currency0 = currency0_;
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;

        // Anchor the band to an EXPLICIT graduation tick the caller passes — never to a live getSlot0 read (an
        // attacker could push spot right before the non-atomic deploy to mis-place the add-only, no-remove wall).
        // The band is the first spacing boundary strictly BELOW the anchor (pure-currency1 region), so the wall
        // sits just under the launch price and only sells token once a pump pushes spot down into it.
        int24 upper = _alignDown(anchorTick - 1, tickSpacing_);
        int24 lower = upper - int24(int256(uint256(bandWidthSpacings))) * tickSpacing_;
        // `upper <= lower` also catches an int24 wrap from an absurd bandWidthSpacings (>=2^23) that would
        // otherwise deploy an inverted, permanently-bricked band.
        if (upper <= lower || lower < TickMath.minUsableTick(tickSpacing_) || upper > TickMath.maxUsableTick(tickSpacing_))
        {
            revert BadBand();
        }
        ambushTickLower = lower;
        ambushTickUpper = upper;
    }

    /// @notice Deploy all on-hand token (the ambush allotment) into the permanent wall. Permissionless. If spot
    /// has fallen into/below the band (so a single-sided currency1 add is not clean), the token parks and is
    /// added on the next call once spot is back above the band.
    function addAmbush() external nonReentrant returns (uint128 added) {
        uint256 amt = currency1.balanceOfSelf();
        if (amt == 0) return 0;
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        if (tick < ambushTickUpper) {
            parkedToken = amt;
            emit AmbushSkipped(tick, amt);
            return 0;
        }
        added = abi.decode(poolManager.unlock(abi.encode(Op.ADD, amt)), (uint128));
    }

    /// @notice Collect the wall's accrued LP fees. The ETH (currency0) side — earned as the wall sells token into
    /// pumps — is swept to the permanent floor; the token (currency1) side is re-parked to deepen the wall on the
    /// next addAmbush(). Never removes principal.
    function collectFees() external nonReentrant {
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
        uint160 sLower = TickMath.getSqrtPriceAtTick(ambushTickLower);
        uint160 sUpper = TickMath.getSqrtPriceAtTick(ambushTickUpper);
        L = LiquidityAmounts.getLiquidityForAmount1(sLower, sUpper, amt);
        if (L == 0) return 0;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({
                tickLower: ambushTickLower,
                tickUpper: ambushTickUpper,
                liquidityDelta: int256(uint256(L)), // ALWAYS positive — no remove path exists
                salt: bytes32(0)
            }),
            ""
        );
        _resolve(currency0, delta.amount0(), address(this));
        _resolve(currency1, delta.amount1(), address(this));
        ambushLiquidity += L;
        parkedToken = 0;
        emit AmbushAdded(amt, L, ambushLiquidity);
    }

    function _collect() internal {
        // a zero-liquidity poke realizes fees as a positive delta; sweep the ETH to the floor, re-park the token
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: ambushTickLower, tickUpper: ambushTickUpper, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        uint256 ethOut;
        uint256 tokBack;
        if (a0 > 0) {
            ethOut = uint256(uint128(a0));
            poolManager.take(currency0, floorRecipient, ethOut); // ETH LP fees → strengthen the permanent floor
        }
        if (a1 > 0) {
            tokBack = uint256(uint128(a1));
            poolManager.take(currency1, address(this), tokBack); // token fees → re-parked, added on next addAmbush
        }
        emit AmbushFeesCollected(ethOut, tokBack);
    }

    /// @dev Settle what the vault owes / take what it is owed for one currency.
    function _resolve(Currency currency, int128 amt, address takeTo) internal {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            if (currency.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), owed);
                poolManager.settle();
            }
        } else if (amt > 0) {
            poolManager.take(currency, takeTo, uint256(uint128(amt)));
        }
    }

    function _alignDown(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 rounded = (tick / spacing) * spacing;
        if (rounded > tick) rounded -= spacing; // floor for negative remainder (Solidity truncates toward zero)
        return rounded;
    }

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
    }

    function _poolId() internal view returns (PoolId) {
        return _poolKey().toId();
    }

    receive() external payable {} // may transiently hold ETH (e.g. add rounding dust)
}
