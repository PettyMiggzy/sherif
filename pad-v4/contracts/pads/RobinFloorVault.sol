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
///
/// [fee-model: PLATFORM TAKES ETH ONLY, NEVER HOLDS PAD TOKENS] Once spot trades into the band the wall
/// holds token and its LP position accrues fees in BOTH currencies. The currency0 (ETH) leg is the money
/// side → platform. The currency1 (TOKEN) leg is NEVER routed to the platform: it PARKS in-vault and is
/// forwarded by `sweepTokenFees()` to the pad's `tokenSink` (its staking / buyback pool), wired once by the
/// platform after the pool exists (mirrors `hook.setFloorRecipient` / `LockVault.setStakingRecipient`).
/// This keeps the platform ETH-only — no pad-token supply ever lands on the treasury key.
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

    // [fee-model] Where the TOKEN-side (currency1) LP fees go. The platform takes ETH only and never holds pad
    // tokens, so the token leg PARKS in-vault and is swept here. Set once by the platform after the pad's staking /
    // buyback pool exists (this vault is deployed pre-launch, before that pool). 0 => token fees park until wired.
    address public tokenSink;

    /// [H-5] The single live `slot0` read that used to be this function's ENTIRE protection gated an
    /// irreversible, unbounded commitment of the whole on-hand carve. In M-15's state — the pad has dumped,
    /// spot sits at or above the band and the carve has been parking — anyone could buy to force the tick
    /// below `floorTickLower`, call addFloor(), and sell back, flipping the carve from "mint nothing" to
    /// "mint everything at a stale band" inside one transaction. Measured profitable (+4.07 ETH in a fully
    /// atomic build with a real 0.05% flash loan) once the parked balance passes ~5% of the pool's ETH depth,
    /// and below that threshold still pure griefing that burned 39-77% of the carve.
    ///
    /// The constants below target the park→commit FLIP. MIN_DWELL requires the tick to have been OBSERVED below the
    /// band for a real time gap before a commit; MAX_COMMIT_BPS caps each commit to a bounded slice; MAX_OBSERVED_GAP
    /// restarts the dwell clock after any long un-poked gap so a stale `belowSince` cannot be replayed. Together these
    /// close the atomic WHOLE-CARVE force-fill and any replay off a belowSince stale by more than MAX_OBSERVED_GAP.
    ///
    /// [re-audit/H-5] HONEST RESIDUAL — this is NOT a full fix. Because COMMIT_COOLDOWN == MIN_DWELL, a BOUNDED slice
    /// (≤MAX_COMMIT_BPS) can still be force-committed off a belowSince stale by ≤MAX_OBSERVED_GAP — in a SINGLE cheap
    /// tx (belowSince may have been set by anyone's earlier commit-region poke; the attacker holds no position between
    /// commits, so the cost is ~2× the pool fee per commit, NOT arbitrage), draining the carve over ~1/MAX_COMMIT_BPS
    /// commits one per COMMIT_COOLDOWN. A poke-observed dwell fundamentally cannot prove continuous below-band price
    /// without a TWAP. The real closure is the floor redesign (M-15/H-5/L-33: add-only bands placed BELOW current
    /// spot, or a TWAP-gated commit) — a product decision.
    ///
    /// The honest path is barely touched: during normal operation a keeper pokes within MAX_OBSERVED_GAP, so the
    /// clock stays valid and every poke commits its slice once MIN_DWELL has elapsed.
    uint32 public constant MIN_DWELL = 10 minutes;
    uint16 public constant MAX_COMMIT_BPS = 2000; // ≤20% of the on-hand carve per commit
    uint32 public constant COMMIT_COOLDOWN = 10 minutes;
    // [re-audit/H-5] If nobody has poked for longer than this, the dwell clock is UNTRUSTED and restarts (see addFloor).
    // Must exceed the honest keeper cadence (~COMMIT_COOLDOWN) so routine operation never resets, but bounds how stale
    // `belowSince` can get during an un-poked dump.
    uint32 public constant MAX_OBSERVED_GAP = 1 hours;
    uint16 internal constant BPS = 10_000;

    uint64 public belowSince; // when the tick was first OBSERVED below the band (0 = last observation was not)
    uint64 public lastCommitAt; // when the last slice was committed
    uint64 public lastObserved; // block.timestamp of the last addFloor observation (any tick) — [re-audit/H-5] anti-stale

    event FloorAdded(uint256 quoteUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event FloorSkipped(int24 currentTick, uint256 parked);
    event FloorFeesCollected(uint256 amount0, uint256 amount1, address ethTo); // ethTo = platform; token (amount1) parks
    event TokenSinkSet(address indexed sink);
    event TokenFeesSwept(address indexed to, uint256 amount);

    error NotPoolManager();
    error NotPlatform();
    error ZeroAddress();
    error BadBand();
    error TokenSinkAlreadySet();
    error NoTokenSink();

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
        uint64 nowTs = uint64(block.timestamp);
        uint64 prevObserved = lastObserved;
        lastObserved = nowTs; // record THIS observation (used to detect an untrusted gap on the next one)
        if (tick >= floorTickLower) {
            belowSince = 0; // observation: NOT below → the dwell clock restarts from the next one
            parkedQuote = amt;
            emit FloorSkipped(tick, amt);
            return 0;
        }
        // [re-audit/H-5] `belowSince` is only ADVANCED by pokes, and pokes are not incentivized during a dump — so a
        // value left over from a prior healthy period would be STALE and let an attacker force-fill the carve off it
        // after an un-poked dump. Restart the clock whenever we can't trust the price stayed below since the last
        // observation: never below (belowSince==0), OR the gap since the last poke is too long to vouch for continuity.
        // CLOSES: the atomic WHOLE-CARVE fill (MAX_COMMIT_BPS caps each commit, COMMIT_COOLDOWN one per block) and any
        // replay off a belowSince stale by MORE than MAX_OBSERVED_GAP.
        // RESIDUAL (needs the floor redesign, M-15/H-5/L-33 — NOT closed here): because COMMIT_COOLDOWN == MIN_DWELL, a
        // BOUNDED slice (≤MAX_COMMIT_BPS) can still be force-committed off a belowSince stale by ≤MAX_OBSERVED_GAP — in
        // a SINGLE cheap tx (belowSince may have been set by anyone's earlier commit-region poke; the attacker holds no
        // position between commits, so the cost is ~2× the pool fee per commit, NOT arbitrage/price risk), draining the
        // carve over ~1/MAX_COMMIT_BPS commits, one per COMMIT_COOLDOWN. A TWAP-gated commit or add-only bands below
        // spot are the real closure; this is interim hardening, not a full fix.
        if (belowSince == 0 || nowTs > prevObserved + MAX_OBSERVED_GAP) belowSince = nowTs;
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

    /// @notice Collect the wall's accrued LP fees: the ETH (currency0) leg to the platform, the TOKEN (currency1)
    /// leg PARKED in-vault (never the platform). Never removes principal. Sweep the parked token via sweepTokenFees.
    function collectFloorFees() external nonReentrant {
        poolManager.unlock(abi.encode(Op.COLLECT, uint256(0)));
    }

    /// @notice Wire the token sink (the pad's staking / buyback pool) exactly ONCE, by the platform. This vault is
    /// deployed pre-launch — before that pool exists — so the token-side LP fee parks in-vault until this points at
    /// the real recipient, then is permanently frozen. Mirrors LockVault.setStakingRecipient / hook.setFloorRecipient.
    function setTokenSink(address sink) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        if (tokenSink != address(0)) revert TokenSinkAlreadySet();
        if (sink == address(0)) revert ZeroAddress();
        tokenSink = sink;
        emit TokenSinkSet(sink);
    }

    /// @notice Forward the floor position's parked TOKEN-side (currency1) LP fees to the wired token sink. Anyone
    /// may call; funds only ever go to the registered sink, NEVER the caller and NEVER the platform. Reverts until
    /// the platform has wired the sink (the token parks in-vault until then, losing nothing).
    function sweepTokenFees() external nonReentrant returns (uint256 amount) {
        address to = tokenSink;
        if (to == address(0)) revert NoTokenSink();
        amount = currency1.balanceOfSelf();
        if (amount == 0) return 0;
        // currency1 is always the pad ERC20 token on these pads (currency0 is the money side), never native.
        IERC20(Currency.unwrap(currency1)).safeTransfer(to, amount);
        emit TokenFeesSwept(to, amount);
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
        // [fee-model] currency1 (token) is NEVER floor principal on this single-sided currency0 wall; fees were
        // already realized by the _collect() above, so this is ~0. PARK any stray in-vault (NEVER the platform — the
        // platform holds no pad tokens); sweepTokenFees() forwards it to the token sink. No longer stranded.
        _resolve(currency1, delta.amount1(), address(this));
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
        address plat = feeRegistry.platformFeeWallet(); // [L-11] resolved live from the timelocked registry
        // currency0 (ETH/money) leg → platform: the platform takes the money side.
        if (a0 > 0) poolManager.take(currency0, plat, uint256(uint128(a0)));
        // [fee-model] currency1 (TOKEN) leg → PARK in-vault (NEVER the platform, which holds no pad tokens). Swept to
        // the token sink (staking / buyback pool) by sweepTokenFees(). This is the platform-token leak, now closed.
        if (a1 > 0) poolManager.take(currency1, address(this), uint256(uint128(a1)));
        emit FloorFeesCollected(a0 > 0 ? uint256(uint128(a0)) : 0, a1 > 0 ? uint256(uint128(a1)) : 0, plat);
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
