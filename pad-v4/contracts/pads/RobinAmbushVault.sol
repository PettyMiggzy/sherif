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
    // [M-26] the curve publishes its whole PoolKey as public immutables; read them instead of trusting params.
    function currency0() external view returns (Currency);
    function currency1() external view returns (Currency);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function hooks() external view returns (IHooks);
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

    event UnsoldBooked(uint256 amount, uint256 principal); // [SELL]
    event SellParked(int24 tick, uint256 amount); // [SELL]
    event SellSeeded(uint256 amount, uint128 liquidityAdded, uint256 totalLiquidity); // [SELL]

    enum Op {
        ADD,
        COLLECT,
        ADD_SELL
    }

    IPoolManager public immutable poolManager;
    IStateView public immutable stateView;
    address public immutable floorRecipient; // ETH LP-fee sink (immutable)
    address public immutable stakingRecipient; // token LP-fee sink; [L-17] required non-zero at deploy (see ctor)

    Currency public immutable currency0; // ETH (address 0)
    Currency public immutable currency1; // token
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;

    int24 public immutable ambushTickLower; // band strictly ABOVE gradTick (below grad price); single-sided ETH
    int24 public immutable ambushTickUpper;

    int24 public immutable sellTickLower; // [SELL] mirror band, token-expensive side of graduation (0 => disabled)
    int24 public immutable sellTickUpper;
    uint128 public ambushLiquidity; // total liquidity permanently locked in the band (only grows)
    // [SELL] the mirror band, on the token-EXPENSIVE side of graduation. Holds unsold pad supply as pure
    // currency1 and converts it to ETH as price RISES into it — passive "sell into strength", no keeper.
    uint128 public sellLiquidity; // liquidity permanently locked in the sell band (only grows)
    uint256 public sellPrincipal; // unsold TOKEN booked as principal, awaiting placement (EXCLUDED from staking sweeps)
    uint256 public parkedToken; // principal received while spot sat inside/below the sell band
    uint256 public parkedEth; // seed ETH received while spot is inside/above the band (added on recovery)
    uint256 public pendingFloorEth; // ETH LP-fees that failed to forward to the floor (EXCLUDED from the seed)
    address public immutable curve; // [SELL] the only address allowed to book unsold supply as principal

    event AmbushSeeded(uint256 ethUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event AmbushParked(int24 currentTick, uint256 parked);
    event AmbushFeesCollected(uint256 ethToFloor, uint256 tokenToStaking, uint256 ethParked);

    error NotPoolManager();
    error ZeroAddress();
    error BadBand();
    error PoolKeyMismatch();
    error NotCurve(); // [SELL] only this pad's curve may book unsold supply as principal

    constructor(
        address poolManager_,
        address stateView_,
        address floorRecipient_,
        address stakingRecipient_, // [L-17] must be non-zero (this vault is deployed post-graduation, after the staking pool exists)
        address curve_,
        Currency currency0_,
        Currency currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        IHooks hooks_,
        uint24 gapSpacings, // spacings ABOVE gradTick before the band starts (0 => engages on the first dip)
        uint24 bandWidthSpacings, // band width in tickSpacings (>=1)
        uint24 sellGapSpacings, // [SELL] spacings BELOW gradTick before the sell band starts
        uint24 sellWidthSpacings // [SELL] sell-band width in tickSpacings (0 => no sell band on this pad)
    ) {
        // [L-17] stakingRecipient is required non-zero: this vault is add-only with no owner/withdraw/setter, so a
        // 0 sink would strand every token-side band fee permanently idle-in-vault. It is deployed after graduation,
        // once the staking pool exists, so the operator always has the real address at deploy time.
        if (
            poolManager_ == address(0) || stateView_ == address(0) || floorRecipient_ == address(0)
                || stakingRecipient_ == address(0) || curve_ == address(0)
        ) {
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

        // [M-26] The [H1] note below was true of the TICK and false of the POOL: currency0/currency1/fee/
        // tickSpacing/hooks arrived as parameters and were stored unchecked, so a vault could anchor its band to
        // THIS curve's gradTick while pointing its PoolKey at a DIFFERENT pad's pool — and then deliver this
        // pad's ambush share as permanent, add-only, unrecoverable liquidity over there. The curve publishes all
        // five; read them rather than trust the caller. Now the [H1] claim holds for the whole key.
        if (
            Currency.unwrap(currency0_) != Currency.unwrap(IRobinCurveGrad(curve_).currency0())
                || Currency.unwrap(currency1_) != Currency.unwrap(IRobinCurveGrad(curve_).currency1())
                || fee_ != IRobinCurveGrad(curve_).fee() || tickSpacing_ != IRobinCurveGrad(curve_).tickSpacing()
                || address(hooks_) != address(IRobinCurveGrad(curve_).hooks())
        ) revert PoolKeyMismatch();

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
        curve = curve_;

        // [SELL] The mirror band. currency0 is the money side, so a HIGHER tick means a CHEAPER token: the buy
        // band above sits at higher ticks (token cheap) and holds pure ETH, and this one sits at LOWER ticks
        // (token expensive) and holds pure TOKEN. A position is 100% currency1 while spot is at or above its
        // upper tick, so at spot == gradTick this seeds entirely in token, and it converts to ETH only as buying
        // pushes the tick DOWN into it. Set back from gradTick by sellGapSpacings so it is never an overhead
        // wall on the freshly graduated price, and it is INERT at or below graduation — it cannot cap the chart.
        // sellWidthSpacings == 0 disables the band entirely, which keeps every existing pad's geometry unchanged.
        if (sellWidthSpacings != 0) {
            int24 sUpper = _alignDown(anchorTick - 1, tickSpacing_)
                - int24(int256(uint256(sellGapSpacings))) * tickSpacing_;
            int24 sLower = sUpper - int24(int256(uint256(sellWidthSpacings))) * tickSpacing_;
            // sLower>=sUpper also catches an int24 wrap from an absurd gap/width (>=2^23 spacings)
            if (
                sLower >= sUpper || sUpper >= anchorTick || sLower < TickMath.minUsableTick(tickSpacing_)
                    || sUpper > TickMath.maxUsableTick(tickSpacing_)
            ) revert BadBand();
            sellTickLower = sLower;
            sellTickUpper = sUpper;
        }
    }

    /// @notice [SELL] Book pad supply the curve did not sell as sell-band PRINCIPAL. Callable only by this pad's
    /// own curve, so nobody can reclassify accrued fee tokens — which belong to staking — as band principal.
    /// Credits at most what actually arrived, so a mis-stated amount can never book more than the vault holds.
    function fundUnsold(uint256 amount) external nonReentrant returns (uint256 booked) {
        if (msg.sender != curve) revert NotCurve();
        if (sellTickUpper == 0 && sellTickLower == 0) return 0; // no sell band on this pad; leave it to staking
        uint256 bal = IERC20(Currency.unwrap(currency1)).balanceOf(address(this));
        booked = amount;
        uint256 room = bal > sellPrincipal ? bal - sellPrincipal : 0;
        if (booked > room) booked = room;
        if (booked == 0) return 0;
        sellPrincipal += booked;
        emit UnsoldBooked(booked, sellPrincipal);
    }

    /// @notice [SELL] Place booked principal into the permanent sell band. Permissionless, add-only, and it
    /// mirrors seedAmbush exactly: if spot sits inside or below the band a clean single-sided TOKEN add is not
    /// possible, so the principal PARKS and any later call places it once spot is back above the band.
    function seedSellBand() external nonReentrant returns (uint128 added) {
        uint256 amt = sellPrincipal;
        if (amt == 0) return 0;
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        // pure currency1 requires the whole range to sit at or below spot
        if (tick < sellTickUpper) {
            parkedToken = amt;
            emit SellParked(tick, amt);
            return 0;
        }
        added = abi.decode(poolManager.unlock(abi.encode(Op.ADD_SELL, amt)), (uint128));
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
    /// token in the staking pool to be credited by balance-accounting on a later push (mirrors the curve).
    /// [L-17] stakingRecipient is guaranteed non-zero by the constructor, so the sink is always wired; the zero
    /// guard below is defensive only.
    function _forwardStaking() internal returns (uint256) {
        address s = stakingRecipient;
        if (s == address(0)) return 0;
        address tok = Currency.unwrap(currency1);
        uint256 tb = IERC20(tok).balanceOf(address(this));
        // [SELL] Principal booked for the sell band is NOT a fee. Without this the first flushFees() would hand
        // every unsold token to staking before it was ever placed, silently deleting the sell band.
        uint256 reserved = sellPrincipal;
        tb = tb > reserved ? tb - reserved : 0;
        if (tb == 0) return 0;
        IERC20(tok).safeTransfer(s, tb);
        try IStakingFund(s).fundTokenPushed(uint8(0), tok) {} catch {}
        return tb;
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Op op, uint256 amt) = abi.decode(data, (Op, uint256));
        if (op == Op.ADD) return abi.encode(_add(amt));
        if (op == Op.ADD_SELL) return abi.encode(_addSell(amt));
        (uint256 e, uint256 t) = _collect();
        return abi.encode(e, t);
    }

    function _add(uint256 amt) internal returns (uint128 L) {
        // [L-18] Realize accrued fees FIRST (same poke as _collect) and route them exactly as the collect path does:
        // the ETH fee is parked into pendingFloorEth (excluded from the seed, forwarded to the floor on the next
        // collect/flush) and the token fee is left idle-in-vault for staking. This makes the positive add below carry
        // PURE PRINCIPAL, so the ETH-fee destination no longer depends on whether seedAmbush() or collectFees() lands
        // first — a 1-wei donation could otherwise fold the ETH fee into the band as principal, diverting it from the
        // floor. `amt` was fixed as (balance - pendingFloorEth) before this unlock, so parking the fee here keeps the
        // seed principal exactly `amt` and preserves the fee ETH in the vault under pendingFloorEth.
        // Guard on ambushLiquidity > 0: a zero-liquidity poke on a never-added position reverts
        // CannotUpdateEmptyPosition, and an empty band has no accrued fees anyway, so the FIRST seed skips it.
        if (ambushLiquidity > 0) {
            (uint256 ethFee,) = _collectRange(ambushTickLower, ambushTickUpper);
            if (ethFee > 0) pendingFloorEth += ethFee;
        }

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

    /// @dev [SELL] Mirror of `_add` for the token side. Realizes the sell band's own accrued fees FIRST and
    /// routes them exactly as the collect path does — ETH parked to pendingFloorEth for the floor, token left
    /// idle-in-vault for staking — so the positive add below carries PURE PRINCIPAL and a fee cannot be folded
    /// into the band. `amt` is `sellPrincipal`, which only this pad's curve can credit, so a token donation can
    /// never become principal. Guarded on sellLiquidity > 0 because a zero-liquidity poke on a never-added
    /// position reverts CannotUpdateEmptyPosition.
    function _addSell(uint256 amt) internal returns (uint128 L) {
        if (sellLiquidity > 0) {
            (uint256 ethFee,) = _collectRange(sellTickLower, sellTickUpper);
            if (ethFee > 0) pendingFloorEth += ethFee;
        }
        uint160 sLower = TickMath.getSqrtPriceAtTick(sellTickLower);
        uint160 sUpper = TickMath.getSqrtPriceAtTick(sellTickUpper);
        L = LiquidityAmounts.getLiquidityForAmount1(sLower, sUpper, amt);
        if (L == 0) return 0;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({
                tickLower: sellTickLower,
                tickUpper: sellTickUpper,
                liquidityDelta: int256(uint256(L)), // ALWAYS positive — no remove path exists
                salt: bytes32(0)
            }),
            ""
        );
        // What the position actually consumed is the token debt the pool just charged us — exact, and it needs
        // no separate estimate that could drift from the pool's own rounding.
        int128 owed1 = delta.amount1();
        _resolve(currency0, delta.amount0());
        _resolve(currency1, owed1);
        sellLiquidity += L;
        // Only the placed principal is consumed; a rounding remainder stays booked for the next seed.
        uint256 placed = owed1 < 0 ? uint256(uint128(-owed1)) : 0;
        sellPrincipal = placed >= sellPrincipal ? 0 : sellPrincipal - placed;
        parkedToken = 0;
        emit SellSeeded(amt, L, sellLiquidity);
    }

    function _collect() internal returns (uint256 e, uint256 t) {
        (e, t) = _collectRange(ambushTickLower, ambushTickUpper);
        if (sellLiquidity > 0) {
            (uint256 e2, uint256 t2) = _collectRange(sellTickLower, sellTickUpper);
            e += e2;
            t += t2;
        }
    }

    function _collectRange(int24 tl, int24 tu) internal returns (uint256 e, uint256 t) {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: 0, salt: bytes32(0)}),
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

    function _alignDown(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 rounded = (tick / spacing) * spacing;
        if (rounded > tick) rounded -= spacing; // floor for negative remainder
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
