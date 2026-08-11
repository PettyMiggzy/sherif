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

interface IRobinCurveGrad {
    function gradTick() external view returns (int24);
}

interface IStakingFund {
    function fundTokenPushed(uint8 side, address asset) external returns (uint256);
}

/// @title RobinAmbushVault — a permanent, two-sided ambush band (buys dips, sells rips) seeded from the raise
/// @notice At graduation the curve sends this vault ~5% of the raise in ETH (ambushGradBps). `seedAmbush()` places
/// it as a SINGLE-SIDED currency0 (ETH) concentrated range in a narrow band strictly BELOW the graduation price
/// (i.e. ABOVE gradTick in tick space) and above the deep floor. It is a PASSIVE Uniswap-v4 position — no keeper,
/// no oracle, no market orders, no on-swap logic:
///   • a DIP (a dump pushes tick up into the band) converts the band's ETH → token in clips: it BUYS the dip;
///   • a RECOVERY (buys push tick back down through the band) sells that token back for ETH: it SELLS into buy
///     pressure, recharging itself;
///   • at/above the graduation price the band holds only ETH and is INERT, so it can NEVER cap the chart.
///
/// It is ADD-ONLY — there is deliberately NO remove/withdraw/burn path, so the band can only deepen and its ETH
/// can only ever leave by TRADING at the AMM's own marginal price. Round-tripping a passive add-only LP is always a
/// LOSS to the attacker (spread + 2× LP fee), so the band is sandwich-proof and its principal is never extractable.
///
/// The band anchor is read from the curve's IMMUTABLE gradTick() on-chain (never a deploy param, never a live
/// getSlot0), so no front-run or bad param can mis-place the wall. Only accrued LP fees ever leave (ETH → floor,
/// token → staking), forwarded AFTER the PoolManager unlock returns with parked-and-retriable failure isolation.
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
    address public immutable floorRecipient; // ETH LP-fee sink (immutable)
    address public immutable stakingRecipient; // token LP-fee sink; may be 0 (then token fees stay idle-in-vault)

    Currency public immutable currency0; // ETH (address 0)
    Currency public immutable currency1; // token
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;

    int24 public immutable ambushTickLower; // band strictly ABOVE gradTick (below grad price); single-sided ETH
    int24 public immutable ambushTickUpper;

    uint128 public ambushLiquidity; // total liquidity permanently locked in the band (only grows)
    uint256 public parkedEth; // seed ETH received while spot is inside/above the band (added on recovery)
    uint256 public pendingFloorEth; // ETH LP-fees that failed to forward to the floor (EXCLUDED from the seed)

    event AmbushSeeded(uint256 ethUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event AmbushParked(int24 currentTick, uint256 parked);
    event AmbushFeesCollected(uint256 ethToFloor, uint256 tokenToStaking, uint256 ethParked);

    error NotPoolManager();
    error ZeroAddress();
    error BadBand();

    constructor(
        address poolManager_,
        address stateView_,
        address floorRecipient_,
        address stakingRecipient_, // may be 0
        address curve_,
        Currency currency0_,
        Currency currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        IHooks hooks_,
        uint24 gapSpacings, // spacings ABOVE gradTick before the band starts (0 => engages on the first dip)
        uint24 bandWidthSpacings // band width in tickSpacings (>=1)
    ) {
        if (poolManager_ == address(0) || stateView_ == address(0) || floorRecipient_ == address(0) || curve_ == address(0)) {
            revert ZeroAddress();
        }
        if (bandWidthSpacings == 0) revert BadBand();
        poolManager = IPoolManager(poolManager_);
        stateView = IStateView(stateView_);
        floorRecipient = floorRecipient_;
        stakingRecipient = stakingRecipient_;
        currency0 = currency0_;
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;

        // [H1] Anchor to the curve's IMMUTABLE gradTick() read on-chain — never a passed hint, never a live spot.
        // The band is the first spacing boundary strictly ABOVE gradTick, plus an optional gap: it sits just below
        // the graduation price in the pure-currency0 (ETH) region, so at spot==gradTick it seeds 100% ETH.
        int24 anchorTick = IRobinCurveGrad(curve_).gradTick();
        int24 lower = _alignUp(anchorTick + 1, tickSpacing_) + int24(int256(uint256(gapSpacings))) * tickSpacing_;
        int24 upper = lower + int24(int256(uint256(bandWidthSpacings))) * tickSpacing_;
        // upper<=lower also catches an int24 wrap from an absurd gap/width (>=2^23 spacings)
        if (
            upper <= lower || lower <= anchorTick || lower < TickMath.minUsableTick(tickSpacing_)
                || upper > TickMath.maxUsableTick(tickSpacing_)
        ) revert BadBand();
        ambushTickLower = lower;
        ambushTickUpper = upper;
    }

    /// @notice Seed all on-hand seed ETH (never the parked fee ETH) into the permanent band. Permissionless. If
    /// spot has risen into/above the band (a griefer dumped first) a clean single-sided ETH add isn't possible, so
    /// the ETH PARKS and any later call seeds it once spot is back below the band. The tick read and the add happen
    /// atomically under the PoolManager lock, so `_add` can never be asked to settle a token debt it doesn't hold.
    function seedAmbush() external nonReentrant returns (uint128 added) {
        uint256 amt = currency0.balanceOfSelf() - pendingFloorEth; // seed only true seed ETH
        if (amt == 0) return 0;
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        if (tick >= ambushTickLower) {
            parkedEth = amt;
            emit AmbushParked(tick, amt);
            return 0;
        }
        added = abi.decode(poolManager.unlock(abi.encode(Op.ADD, amt)), (uint128));
    }

    /// @notice Realize the band's accrued LP fees and forward them: ETH → floor vault, token → staking. Never
    /// removes principal. Both legs are taken to self INSIDE the lock, then forwarded AFTER unlock returns (no
    /// recipient call under the pool lock); a reverting/unwired sink parks the ETH (pendingFloorEth, excluded from
    /// the seed) or leaves the token idle-in-vault — collection can never revert and principal is never at risk.
    function collectFees() external nonReentrant {
        (uint256 ethFee,) = abi.decode(poolManager.unlock(abi.encode(Op.COLLECT, uint256(0))), (uint256, uint256));
        uint256 ethToFloor = _forwardFloor(ethFee);
        uint256 tokenToStaking = _forwardStaking();
        emit AmbushFeesCollected(ethToFloor, tokenToStaking, pendingFloorEth);
    }

    /// @notice Permissionless retry of any parked ETH fees + idle token fees, without a fresh fee realization.
    function flushFees() external nonReentrant {
        uint256 ethToFloor = _forwardFloor(0);
        uint256 tokenToStaking = _forwardStaking();
        emit AmbushFeesCollected(ethToFloor, tokenToStaking, pendingFloorEth);
    }

    // ── internals ───────────────────────────────────────────────────────────────────

    /// @dev Forward `fresh` ETH fees plus any previously parked ETH to the floor; re-park the whole amount on a
    /// failed send. Returns the amount successfully forwarded.
    function _forwardFloor(uint256 fresh) internal returns (uint256) {
        uint256 e = fresh + pendingFloorEth;
        if (e == 0) return 0;
        pendingFloorEth = 0;
        (bool ok,) = floorRecipient.call{value: e}("");
        if (!ok) {
            pendingFloorEth = e;
            return 0;
        }
        return e;
    }

    /// @dev Push the vault's idle token (collected token fees + any donated token) to staking; a revert leaves the
    /// token in the staking pool to be credited by balance-accounting on a later push (mirrors the curve). If no
    /// staking sink is wired, the token stays idle-in-vault (un-ruggable, retried later).
    function _forwardStaking() internal returns (uint256) {
        address s = stakingRecipient;
        if (s == address(0)) return 0;
        address tok = Currency.unwrap(currency1);
        uint256 tb = IERC20(tok).balanceOf(address(this));
        if (tb == 0) return 0;
        IERC20(tok).safeTransfer(s, tb);
        try IStakingFund(s).fundTokenPushed(uint8(0), tok) {} catch {}
        return tb;
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Op op, uint256 amt) = abi.decode(data, (Op, uint256));
        if (op == Op.ADD) return abi.encode(_add(amt));
        (uint256 e, uint256 t) = _collect();
        return abi.encode(e, t);
    }

    function _add(uint256 amt) internal returns (uint128 L) {
        uint160 sLower = TickMath.getSqrtPriceAtTick(ambushTickLower);
        uint160 sUpper = TickMath.getSqrtPriceAtTick(ambushTickUpper);
        L = LiquidityAmounts.getLiquidityForAmount0(sLower, sUpper, amt);
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
        _resolve(currency0, delta.amount0());
        _resolve(currency1, delta.amount1());
        ambushLiquidity += L;
        parkedEth = 0;
        emit AmbushSeeded(amt, L, ambushLiquidity);
    }

    function _collect() internal returns (uint256 e, uint256 t) {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: ambushTickLower, tickUpper: ambushTickUpper, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 > 0) {
            e = uint256(uint128(a0));
            poolManager.take(currency0, address(this), e); // to self; forwarded after unlock
        }
        if (a1 > 0) {
            t = uint256(uint128(a1));
            poolManager.take(currency1, address(this), t); // to self; forwarded after unlock
        }
    }

    /// @dev Settle what the band owes (negative delta). A single-sided ETH add owes only currency0.
    function _resolve(Currency currency, int128 amt) internal {
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
            poolManager.take(currency, address(this), uint256(uint128(amt)));
        }
    }

    function _alignUp(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 rounded = (tick / spacing) * spacing;
        if (rounded < tick) rounded += spacing; // ceil for positive remainder
        return rounded;
    }

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
    }

    function _poolId() internal view returns (PoolId) {
        return _poolKey().toId();
    }

    receive() external payable {} // holds the seed ETH + native LP fees transiently
}
