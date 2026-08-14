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
import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";

/// @title RobinFloorVault — a permanent, fee-funded price floor
/// @notice A single-sided QUOTE (currency0) position at a FIXED band just below the launch price: a standing
/// buy wall that catches sellers if the token dumps. It is fed by the pad's fee carve (the sell-tax
/// floor slice + optionally LP fees), and it is ADD-ONLY — there is deliberately NO remove/withdraw
/// path. That absence IS the "can't rug to zero" guarantee.
///
/// [M-15] HONEST SCOPE: the wall is a FIXED buy wall at the launch price, DEEPENED WHILE THE TOKEN TRADES ABOVE IT.
/// It does not "only ever deepen" unconditionally — once spot falls INTO/below the single fixed band, addFloor()
/// parks the carve (a single-sided currency0 add isn't clean there) and it idles until price recovers above the
/// band. So a token in a sustained drawdown accrues carve that sits parked rather than adding depth. Widening this
/// to place new bands below spot is a product decision (see M-15/H-5/L-33 in AUDITOR-HANDOFF.md), not shipped here.
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
    using SafeERC20 for IERC20;

    enum Op {
        ADD,
        COLLECT
    }

    IPoolManager public immutable poolManager;
    IStateView public immutable stateView;
    // [L-11] Resolve the platform sink LIVE from the timelocked registry at each use, so a 2-day platform-wallet
    // rotation reaches an already-deployed floor vault instead of paying the retired key forever (mirrors LockVault).
    IFeeWalletRegistry public immutable feeRegistry;

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

    /// [H-5] The single live `slot0` read that used to be this function's ENTIRE protection gated an
    /// irreversible, unbounded commitment of the whole on-hand carve. In M-15's state — the pad has dumped,
    /// spot sits at or above the band and the carve has been parking — anyone could buy to force the tick
    /// below `floorTickLower`, call addFloor(), and sell back, flipping the carve from "mint nothing" to
    /// "mint everything at a stale band" inside one transaction. Measured profitable (+4.07 ETH in a fully
    /// atomic build with a real 0.05% flash loan) once the parked balance passes ~5% of the pool's ETH depth,
    /// and below that threshold still pure griefing that burned 39-77% of the carve.
    ///
    /// The two constants below target the park→commit FLIP, which is what the finding requires — delaying or
    /// randomising *when* the call may run changes nothing, because what gets minted does not depend on the
    /// tick. MIN_DWELL forbids committing on a tick that only just arrived below the band, so the attack
    /// cannot be atomic: the pusher must hold the price down across a real time gap, exposed to arbitrage.
    /// MAX_COMMIT_BPS caps how much of the carve any single commit can flip, so the attacker's fixed push
    /// cost (~1.5 ETH of price impact plus 2-4% in LP fee and buy tax) buys a bounded slice instead of the
    /// whole balance — moving the profitability threshold out by 1/MAX_COMMIT_BPS.
    ///
    /// The honest path is barely touched: the band sits ABOVE spot by construction, so in normal operation
    /// the tick has been below it continuously and `belowSince` is already old — every poke commits its slice
    /// immediately. Only a tick that has *just* been shoved below the band has to wait.
    uint32 public constant MIN_DWELL = 10 minutes;
    uint16 public constant MAX_COMMIT_BPS = 2000; // ≤20% of the on-hand carve per commit
    uint32 public constant COMMIT_COOLDOWN = 10 minutes;
    uint16 internal constant BPS = 10_000;

    uint64 public belowSince; // when the tick was first OBSERVED below the band (0 = last observation was not)
    uint64 public lastCommitAt; // when the last slice was committed

    event FloorAdded(uint256 quoteUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event FloorSkipped(int24 currentTick, uint256 parked);
    event FloorFeesCollected(uint256 amount0, uint256 amount1, address to);

    error NotPoolManager();
    error ZeroAddress();
    error BadBand();

    constructor(
        address poolManager_,
        address stateView_,
        address feeRegistry_, // [L-11] the timelocked registry, not a raw platform address
        Currency currency0_,
        Currency currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        IHooks hooks_,
        int24 anchorTick, // the pad's intended launch tick — the band anchors here, NOT to live spot
        uint24 bandWidthSpacings // how many tickSpacings wide the wall is (>=1)
    ) {
        if (poolManager_ == address(0) || stateView_ == address(0) || feeRegistry_ == address(0)) revert ZeroAddress();
        if (bandWidthSpacings == 0) revert BadBand();
        poolManager = IPoolManager(poolManager_);
        stateView = IStateView(stateView_);
        feeRegistry = IFeeWalletRegistry(feeRegistry_);
        currency0 = currency0_;
        currency1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;

        // [audit L1] Anchor the band to an EXPLICIT launch tick the platform passes — never to a live
        // getSlot0 read, which an attacker could push right before the (non-atomic) vault deploy to
        // permanently mis-place the add-only, no-remove wall. The band is the first spacing boundary
        // strictly ABOVE the anchor (pure-currency0 region), so the wall sits just below the launch price.
        int24 lower = _alignUp(anchorTick + 1, tickSpacing_);
        int24 upper = lower + int24(int256(uint256(bandWidthSpacings))) * tickSpacing_;
        // [re-audit] `upper <= lower` also catches an int24 wrap from an absurd bandWidthSpacings (>=2^23)
        // that would otherwise deploy an inverted, permanently-bricked band.
        if (upper <= lower || lower < TickMath.minUsableTick(tickSpacing_) || upper > TickMath.maxUsableTick(tickSpacing_)) {
            revert BadBand();
        }
        floorTickLower = lower;
        floorTickUpper = upper;
    }

    /// @notice Deploy on-hand quote (the carve) into the permanent wall. Permissionless. If spot has fallen
    /// into/below the band (so a single-sided currency0 add is not clean), the quote parks and is added on a
    /// later call once spot is back above the band.
    /// [H-5] A commit additionally requires the tick to have been observed below the band at least MIN_DWELL
    /// ago, and moves at most MAX_COMMIT_BPS of the balance per COMMIT_COOLDOWN. Anyone may poke to record an
    /// observation; a poke that cannot commit yet simply parks, exactly as an out-of-band poke always did.
    function addFloor() external nonReentrant returns (uint128 added) {
        uint256 amt = currency0.balanceOfSelf();
        if (amt == 0) return 0;
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        if (tick >= floorTickLower) {
            belowSince = 0; // observation: NOT below → the dwell clock restarts from the next one
            parkedQuote = amt;
            emit FloorSkipped(tick, amt);
            return 0;
        }
        if (belowSince == 0) belowSince = uint64(block.timestamp); // first observation below — start the clock
        // not settled below the band long enough, or too soon after the last slice → record and park
        if (block.timestamp < uint256(belowSince) + MIN_DWELL || block.timestamp < uint256(lastCommitAt) + COMMIT_COOLDOWN) {
            parkedQuote = amt;
            emit FloorSkipped(tick, amt);
            return 0;
        }
        uint256 slice = (amt * MAX_COMMIT_BPS) / BPS;
        if (slice == 0) slice = amt; // a balance too small to slice goes in whole rather than sticking forever
        lastCommitAt = uint64(block.timestamp);
        added = abi.decode(poolManager.unlock(abi.encode(Op.ADD, slice)), (uint128));
        parkedQuote = currency0.balanceOfSelf(); // whatever this commit did not take stays parked, exactly
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
        // [L-18] Realize any accrued fees FIRST (this is exactly _collect: a zero-liquidity poke that routes both
        // legs to the platform), so the positive add below carries PURE PRINCIPAL. Without this, a positive
        // modifyLiquidity returns callerDelta = principal + feesAccrued, folding the currency0 fees into the wall as
        // principal — a different destination than the collect path — so a 1-wei donation could let anyone pre-empt a
        // keeper sweep and divert fees by choosing which call lands first. Pre-realizing makes fee routing deterministic.
        // Guard on floorLiquidity > 0: a zero-liquidity poke on a never-added position reverts CannotUpdateEmptyPosition,
        // and an empty band has no accrued fees anyway, so the FIRST add correctly skips it.
        if (floorLiquidity > 0) _collect();

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
        // currency0 is the floor's own working capital (ETH principal) → keep any positive delta in the vault.
        _resolve(currency0, delta.amount0(), address(this));
        // [audit] currency1 (token) is NEVER floor principal on this single-sided currency0 wall; fees were already
        // realized to the platform by the _collect() above, so this is ~0. Route defensively to the platform anyway —
        // taking a stray to the vault would strand it, since no function moves an idle currency1 balance out.
        _resolve(currency1, delta.amount1(), feeRegistry.platformFeeWallet());
        floorLiquidity += L;
        // [H-5] parkedQuote is reconciled by the caller from the real balance after the unlock closes — this
        // call now commits a SLICE, so zeroing it here would under-report the carve still waiting.
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
        address to = feeRegistry.platformFeeWallet(); // [L-11] resolved live from the timelocked registry
        if (a0 > 0) poolManager.take(currency0, to, uint256(uint128(a0)));
        if (a1 > 0) poolManager.take(currency1, to, uint256(uint128(a1)));
        emit FloorFeesCollected(a0 > 0 ? uint256(uint128(a0)) : 0, a1 > 0 ? uint256(uint128(a1)) : 0, to);
    }

    /// @dev Settle what the vault owes / take what it is owed for one currency.
    function _resolve(Currency currency, int128 amt, address takeTo) internal {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            if (currency.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), owed); // [audit L2]
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
