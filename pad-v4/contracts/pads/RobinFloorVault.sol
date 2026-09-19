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
import {IFeeWalletRegistry, IRobinFloorGate} from "../interfaces/IRobinInterfaces.sol";

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
    // buyback pool exists, which is after the pad's own launch. 0 => token fees park in-vault until wired.
    address public tokenSink;

    // ------------------------------------------------------------------ //
    //   [H-5] THE FLOOR GATE — swap-witnessed below-band proof + a         //
    //         non-refilling, episode-scoped commit allowance (OTG-2).      //
    // ------------------------------------------------------------------ //
    /// The single live `slot0` read that used to be this function's ENTIRE protection gated an irreversible,
    /// unbounded commitment of the whole on-hand carve. On a dumped pad — spot at/above the band, carve parking —
    /// anyone could buy to force the tick below `floorTickLower`, call addFloor(), and sell back, flipping the
    /// carve from "mint nothing" to "mint everything at a stale band" inside one transaction.
    ///
    /// Two economic facts, both MEASURED in this repo, govern the design and kill every "wait longer" gate:
    ///   T1 — holding costs NOTHING per unit time. A push -> hold -> sell-back round trip measured the same to the
    ///        wei at 0s and at 3h of hold. Attacker cost is per ROUND TRIP, never per second. So `MIN_DWELL`,
    ///        `COMMIT_COOLDOWN` and any TWAP window are inert AS SECURITY CONTROLS.
    ///   T2 — a time-weighted average is a DECAYING MEMORY: after a genuine crash it keeps reading "below band"
    ///        for a bounded interval, and inside that interval the force-fill is fully atomic again.
    /// Corollary: extraction ~= G x (rate at which the vault commits new ETH). The fix must bound ETH COMMITTED
    /// PER UNIT OF ATTACKER COST, and prove duration EXACTLY rather than by averaging.
    ///
    /// P1 — `aboveLowerTs` WATERMARK (the gate). `RobinFeeHook` stamps, on EVERY swap, the timestamp whenever the
    ///      PRE-swap tick is >= `floorTickLower`. A commit requires `now >= aboveLowerTs + MIN_BELOW_DURATION`.
    ///      An above-band -> below-band transition IS a swap whose pre-swap tick is above the band, so the
    ///      attacker's own push closes the gate in the same transaction. Exact, O(1), swap-clocked, no poke.
    /// P2 — EPISODE-SCOPED COMMIT ALLOWANCE. An "episode" is the run since the tick was last observed at/above the
    ///      band. Within one episode the vault may commit at most `EPISODE_BASE_WEI + every wei that arrived at
    ///      the vault during that episode`. NO TIME REFILL: one round trip funds one allowance, priced strictly
    ///      below that round trip's own irreducible fee, so holding longer buys nothing.
    /// P3 — the live-spot read is RETAINED but DEMOTED from "the gate" to a SETTLEMENT PRECONDITION, and
    ///      re-evaluated inside `unlockCallback` atomically with the mint.
    /// P4 — a TWAP over `TWAP_WINDOW` as a required-when-available conjunct: provably implied by P1, retained as
    ///      defence-in-depth against a P1 implementation bug. It is NOT load-bearing.
    /// P5 — `belowSince` / `MIN_DWELL` / `lastObserved` / `MAX_OBSERVED_GAP` / `MAX_COMMIT_BPS` /
    ///      `COMMIT_COOLDOWN` retained byte-for-byte at their shipped values, as subordinate AND-terms.
    ///
    /// [R3 N-B — the external auditor's must-fix, and the one place this DEVIATES from the spec's first draft]
    /// The draft anchored the episode on `aboveUpperTs` (the tick crossing `floorTickUpper`). A dump that stalls
    /// ANYWHERE inside `[floorTickLower, floorTickUpper)` never crosses that pivot, so the episode never rolled,
    /// `episodeStartQuote` kept its zero default and the allowance stayed effectively UNCAPPED — and the auditor
    /// measured the force-fill going net-positive from the band midpoint upward, entirely below that pivot.
    /// The episode is therefore anchored on `aboveLowerTs`: ANY touch of the band, shallow or deep, rolls it.
    /// Re-derived bound across the whole shallow range: linearising near the band, G ~= 2*N_push/D while a round
    /// trip costs 2*beta_net*N_push, so profit/cost = cap/(beta_net*D) INDEPENDENT of push depth. With
    /// `cap = EPISODE_BASE_WEI = D/10_000` and the worst-attacker `beta_net = 0.8%`, that is ~80x unprofitable at
    /// every depth. The draft's second allowance term (0.5% of the band at episode start) is DELIBERATELY NOT
    /// SHIPPED: its 3.2x margin was priced against the cost of crossing the WHOLE band, which the N-B fix no
    /// longer requires, and it turns profitable once the band holds more than ~1.58x the pool's ETH depth.
    ///
    /// ACCEPTED RESIDUAL (R1, liveness): carve accrued in a PREVIOUS episode deploys only 1:1 with new inflow.
    /// That backlog IS the prize the auditor measured; making it un-drainable in bulk is the security property.
    /// Nothing is lost — the vault is add-only, `parkedQuote` is exact, and the ETH can only ever leave into the
    /// band. See FLOOR-H5-CLOSURE-SPEC.md for the full derivation and FLOOR-REDESIGN.md for the refuted designs.
    uint32 public constant MIN_DWELL = 10 minutes;
    uint16 public constant MAX_COMMIT_BPS = 2000; // <=20% of the on-hand carve per commit
    /// [R3-H5] MUST stay STRICTLY GREATER THAN MAX_OBSERVED_GAP — the inequality the repo measured as
    /// load-bearing against the token-flat round-trip loop (10m => attacker +8.7340 ETH; 65m => -0.2090 ETH).
    /// Under P1/P2 it is no longer what carries the security argument; retained unchanged as a subordinate
    /// AND-term, and because the external auditor asked for it to be kept.
    uint32 public constant COMMIT_COOLDOWN = 65 minutes;
    /// If nobody has poked for longer than this, the legacy dwell clock is UNTRUSTED and restarts.
    uint32 public constant MAX_OBSERVED_GAP = 1 hours;
    /// [H-5/P1] Continuous, swap-witnessed, zero-excursion below-band price required before ANY commit.
    /// `= TWAP_WINDOW = 3 x COMMIT_COOLDOWN` (the auditor's literal sizing requirement).
    uint32 public constant MIN_BELOW_DURATION = 195 minutes;
    /// [H-5/P4] `W >= 3 x COMMIT_COOLDOWN` -> 11,700 = 3 x 3,900 (equality).
    uint32 public constant TWAP_WINDOW = 195 minutes;
    int256 public constant TWAP_UNAVAILABLE = type(int256).max;

    // Why a poke parked — emitted on every skip so a stuck floor is diagnosable off-chain without tracing.
    uint8 public constant R_ORACLE = 1; // hook unreadable / unarmed / armed for a different band
    uint8 public constant R_SPOT = 2; // live spot inside/above the band (settlement precondition)
    uint8 public constant R_WARMUP = 3; // gate armed less than MIN_BELOW_DURATION ago
    uint8 public constant R_BELOW = 4; // price was witnessed at/above the band too recently  <-- THE GATE
    uint8 public constant R_TWAP = 5; // the average over TWAP_WINDOW is not below the band
    uint8 public constant R_DWELL = 6; // legacy poke dwell (retained, subordinate)
    uint8 public constant R_COOLDOWN = 7; // legacy pace limiter (retained, unchanged)
    uint8 public constant R_BUDGET = 8; // episode allowance exhausted

    uint16 internal constant BPS = 10_000;

    uint64 public belowSince; // when the tick was first OBSERVED below the band (0 = last observation was not)
    uint64 public lastCommitAt; // when the last slice was committed
    uint64 public lastObserved; // block.timestamp of the last addFloor observation (any tick) — [re-audit/H-5] anti-stale

    /// [H-5/P2] Cumulative currency0 PRINCIPAL committed into the band. Only ever grows, and only inside `_add`.
    uint256 public bandQuoteWei;
    /// [H-5/P2] The `aboveLowerTs` value this episode is scoped to. 0 (the default) is the pad's FIRST episode —
    /// a healthy pad never touches the band, so it keeps `episodeStartQuote == 0` and an inflow-equal allowance,
    /// which is exactly what preserves the honest path.
    uint64 public episodeAnchor;
    /// [H-5/P2] The vault's currency0 balance when this episode began. Cumulative inflow is DERIVABLE, never
    /// tracked: the only outflow from this balance is a commit into the band (currency0 LP fees go straight to
    /// the platform via `poolManager.take` inside `_collect` and never enter it; currency1 is an ERC20). So
    /// inflow during the episode collapses to `amt - episodeStartQuote`.
    uint256 public episodeStartQuote;

    /// [H-5/P2] Per-episode base allowance. Runbook value `seedQuoteWei / 10_000` (1 bp of the pool's seed ETH).
    /// DERIVED FROM THE LAUNCH CONFIG CONSTANT, never from a chain read — a live depth/liquidity read was measured
    /// 335x inflatable by a one-spacing JIT straddle across the non-atomic launch -> vault-deploy gap.
    uint256 public immutable EPISODE_BASE_WEI;

    event FloorAdded(uint256 quoteUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event FloorSkipped(int24 currentTick, uint256 parked);
    event FloorFeesCollected(uint256 amount0, uint256 amount1, address ethTo); // ethTo = platform; token (amount1) parks
    event TokenSinkSet(address indexed sink);
    event TokenFeesSwept(address indexed to, uint256 amount);
    event FloorParked(uint8 reason, int24 spotTick, int24 twapTick, uint256 parked);
    event FloorEpisodeReset(uint64 anchor, uint256 startQuote);
    event FloorCommitted(uint256 slice, uint128 added, uint256 allowance, uint256 bandQuoteWei);
    event FloorMintAborted(int24 tick);

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
        uint24 bandWidthSpacings, // how many tickSpacings wide the wall is (>=1)
        uint256 episodeBaseWei_ // [H-5/P2] per-episode base allowance; runbook value seedQuoteWei / 10_000
    ) {
        if (poolManager_ == address(0) || stateView_ == address(0) || feeRegistry_ == address(0)) revert ZeroAddress();
        if (bandWidthSpacings == 0) revert BadBand();
        if (episodeBaseWei_ == 0) revert BadBand(); // a zero base would park a healthy pad's very first episode
        EPISODE_BASE_WEI = episodeBaseWei_;
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

    /// @notice Deploy on-hand quote (the carve) into the permanent wall. Permissionless. If the gate is not
    /// satisfied — for ANY of the eight reasons below — the quote simply PARKS and is added on a later call.
    /// This function never reverts on a gate failure and never reverts on an unreadable hook: a park is always
    /// the safe outcome, because the vault is add-only and `parkedQuote` is exact.
    function addFloor() external nonReentrant returns (uint128 added) {
        uint256 amt = currency0.balanceOfSelf();
        if (amt == 0) return 0;
        PoolId id = _poolId();

        // ── L1 · READ THE HOOK GATE STATE. [H-3]-safe: low-level staticcall + length check + flat single-word
        //         decode. address(0) / EOA / a pre-gate hook / a short return / a dirty word / a hook armed for a
        //         DIFFERENT band all resolve to PARK. Never a revert, never a brick.
        (bool gOk, uint64 armedAt, uint64 aboveLowerTs) = _gateState(id);
        if (!gOk) return _park(amt, 0, 0, R_ORACLE);

        // ── L2 · EPISODE BOOKKEEPING. [R3 N-B] The episode is anchored on `aboveLowerTs` — ANY touch of the band,
        //         shallow or deep — not on the deep `aboveUpperTs` crossing the first draft used. Done BEFORE any
        //         early return so the snapshot is taken at the EARLIEST poke of the episode, which is the most
        //         conservative anchor available (a later snapshot would count more inflow into the allowance).
        if (aboveLowerTs != episodeAnchor) {
            episodeAnchor = aboveLowerTs;
            episodeStartQuote = amt;
            emit FloorEpisodeReset(aboveLowerTs, amt);
        }

        // ── L3 · LIVE SPOT — DEMOTED from "the gate" to a SETTLEMENT PRECONDITION. This is the only guarantee the
        //         band is pure-currency0 at current spot, which `_add`'s getLiquidityForAmount0 and the
        //         `_resolve(currency1, …)` leg depend on. It is monotone-conservative: it can only turn a commit
        //         into a PARK, never force one. The legacy poke-dwell bookkeeping is preserved here exactly.
        (, int24 spot,,) = stateView.getSlot0(id);
        uint64 nowTs = uint64(block.timestamp);
        uint64 prevObserved = lastObserved;
        lastObserved = nowTs;
        if (spot >= floorTickLower) {
            belowSince = 0;
            return _park(amt, spot, 0, R_SPOT);
        }
        if (belowSince == 0 || nowTs > prevObserved + MAX_OBSERVED_GAP) belowSince = nowTs;

        // ── L4 · THE GATE. Swap-witnessed, exact, unaveraged proof of CONTINUOUS below-band price. Coverage is
        //         total: the tick cannot move without a swap, every swap's pre-swap tick is inspected (same-second
        //         swaps included), and the tail [last swap, now] is covered by the L3 live read. So passing L4
        //         proves the tick was < floorTickLower at EVERY instant of [now - MIN_BELOW_DURATION, now].
        if (nowTs < armedAt + MIN_BELOW_DURATION) return _park(amt, spot, 0, R_WARMUP);
        if (nowTs < aboveLowerTs + MIN_BELOW_DURATION) return _park(amt, spot, 0, R_BELOW);

        // ── L5 · TWAP conjunct (P4). Provably implied by L4 — a window containing no above-band instant has an
        //         average below the band — so it costs zero liveness. Unavailable (cold ring / stretched span)
        //         means L4 alone governs; an attacker cannot force unavailability, because the ring only grows.
        int256 tw = _twap(id, TWAP_WINDOW);
        if (tw != TWAP_UNAVAILABLE && tw >= int256(floorTickLower)) return _park(amt, spot, int24(tw), R_TWAP);
        int24 twTick = tw == TWAP_UNAVAILABLE ? int24(0) : int24(tw);

        // ── L6 · LEGACY PACE — retained unchanged, subordinate AND-terms.
        if (block.timestamp < uint256(belowSince) + MIN_DWELL) return _park(amt, spot, twTick, R_DWELL);
        if (block.timestamp < uint256(lastCommitAt) + COMMIT_COOLDOWN) return _park(amt, spot, twTick, R_COOLDOWN);

        // ── L7 · SIZE — the episode allowance. Every term is a CEILING, so the composed policy is never more
        //         permissive than the shipped MAX_COMMIT_BPS slice.
        uint256 allow = _episodeAllowance(amt);
        uint256 slice = (amt * MAX_COMMIT_BPS) / BPS;
        if (slice == 0 && amt <= allow) slice = amt; // a balance too small to slice goes in whole — never above allow
        if (slice > allow) slice = allow;
        if (slice > amt) slice = amt;
        if (slice == 0) return _park(amt, spot, twTick, R_BUDGET);

        added = abi.decode(poolManager.unlock(abi.encode(Op.ADD, slice)), (uint128));
        if (added > 0) lastCommitAt = nowTs; // never burn a cooldown on a no-op mint
        parkedQuote = currency0.balanceOfSelf(); // whatever this commit did not take stays parked, exactly
        emit FloorCommitted(slice, added, allow, bandQuoteWei);
    }

    /// @dev Record the poke, park the carve, and say which layer refused. `FloorSkipped` keeps its exact
    /// signature (existing assertions depend on it); `FloorParked` is the new diagnostic.
    function _park(uint256 amt, int24 spot, int24 tw, uint8 reason) private returns (uint128) {
        parkedQuote = amt;
        emit FloorSkipped(spot, amt);
        emit FloorParked(reason, spot, tw, amt);
        return 0;
    }

    /// @dev [H-5/P2] Within one episode, cumulative `bandQuoteWei` growth never exceeds
    /// `EPISODE_BASE_WEI + every wei of currency0 that arrived at the vault during that episode`.
    /// Cumulative inflow is DERIVABLE, never tracked: commits into the band are the only outflow from this
    /// balance (currency0 LP fees are taken straight to the platform inside `_collect` and never land here, and
    /// currency1 is an ERC20), so inflow during the episode is exactly `amt - episodeStartQuote`.
    function _episodeAllowance(uint256 amt) internal view returns (uint256) {
        uint256 cap = EPISODE_BASE_WEI;
        if (amt >= episodeStartQuote) return cap + (amt - episodeStartQuote); // + this episode's inflow
        uint256 spent = episodeStartQuote - amt; // the cap already consumed by earlier commits this episode
        return spent >= cap ? 0 : cap - spent;
    }

    /// @dev Read the hook's floor-gate watermarks. Every failure mode degrades to "park", never to a revert:
    /// `address(0)`/EOA returns ok with 0 bytes (caught by the length check); an unarmed hook returns
    /// `armedAt == 0`; a hook armed for a DIFFERENT band fails the `gateLower` cross-check. That cross-check is
    /// what binds the two contracts' constants together on-chain, so a mis-wire cannot silently pass.
    function _gateState(PoolId id) internal view returns (bool ok, uint64 armedAt, uint64 aboveLowerTs) {
        (bool s, bytes memory d) =
            address(hooks).staticcall(abi.encodeWithSelector(IRobinFloorGate.floorGateState.selector, id));
        if (!s || d.length < 128) return (false, 0, 0);
        (uint256 a, uint256 lo,, int256 gl) = abi.decode(d, (uint256, uint256, uint256, int256));
        if (a == 0) return (false, 0, 0); // not armed
        if (gl != int256(floorTickLower)) return (false, 0, 0); // armed for a DIFFERENT band -> park
        if (a > type(uint64).max || lo > type(uint64).max) return (false, 0, 0);
        return (true, uint64(a), uint64(lo));
    }

    /// @dev Defence-in-depth only (P4). Any failure — unreadable hook, short return, sentinel, out-of-range
    /// garbage — reads as TWAP_UNAVAILABLE, which lets L4 govern alone rather than blocking the honest path.
    function _twap(PoolId id, uint32 w) internal view returns (int256) {
        (bool s, bytes memory d) =
            address(hooks).staticcall(abi.encodeWithSelector(IRobinFloorGate.consultTick.selector, id, w));
        if (!s || d.length < 32) return TWAP_UNAVAILABLE;
        int256 t;
        assembly ("memory-safe") {
            t := mload(add(d, 32))
        }
        if (t < TickMath.MIN_TICK || t > TickMath.MAX_TICK) return TWAP_UNAVAILABLE; // sentinel OR garbage
        return t;
    }

    /// @notice This vault's pool id. Read by `RobinFeeHook.armFloorGate` so arming hard-reverts on a mis-wired pair.
    function poolId() external view returns (PoolId) {
        return _poolId();
    }

    /// @notice Ops surface for the keeper, `check-wiring.js` and the indexer — the whole gate in one read.
    function gateStatus()
        external
        view
        returns (bool armed, bool warm, uint64 aboveLowerTs, int256 twapTick, uint256 allowance, int24 spot)
    {
        PoolId id = _poolId();
        uint64 armedAt;
        (armed, armedAt, aboveLowerTs) = _gateState(id);
        warm = armed && block.timestamp >= uint256(armedAt) + MIN_BELOW_DURATION
            && block.timestamp >= uint256(aboveLowerTs) + MIN_BELOW_DURATION;
        twapTick = _twap(id, TWAP_WINDOW);
        allowance = _episodeAllowance(currency0.balanceOfSelf());
        (, spot,,) = stateView.getSlot0(id);
    }

    /// @notice Collect the wall's accrued LP fees: the ETH (currency0) leg to the platform, the TOKEN (currency1)
    /// leg PARKED in-vault (never the platform). Never removes principal. Sweep the parked token via sweepTokenFees.
    function collectFloorFees() external nonReentrant {
        poolManager.unlock(abi.encode(Op.COLLECT, uint256(0)));
    }

    /// @notice Wire the token sink (the pad's staking / buyback pool) exactly ONCE, by the platform. This vault is
    /// deployed as part of the launch runbook — before the staking/buyback pool exists — so the token-side LP fee
    /// parks in-vault until this points at the real recipient, then is permanently frozen. Mirrors LockVault.setStakingRecipient / hook.setFloorRecipient.
    function setTokenSink(address sink) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        if (tokenSink != address(0)) revert TokenSinkAlreadySet();
        // [F2] must be a real external contract (the staking/treasury sink), never a zero/EOA or this vault itself —
        // the same zero + code.length + self guard set the peer one-shot sink setters carry
        // (curve.setStaking/setFloor/setAmbush [R3], LockVault.setStakingRecipient [R3-F2], hook.setFloorRecipient).
        if (sink == address(0) || sink.code.length == 0 || sink == address(this)) revert ZeroAddress();
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

        // [H-5/P3] RE-CHECK the settlement precondition AFTER `_collect` and immediately before the mint,
        // atomically with it. `_collect` does `poolManager.take(currency0, platformWallet, …)`; for native ETH
        // that forwards FULL GAS while the PoolManager is unlocked, so a platform wallet that is a contract can
        // swap and move the tick in between. Two failure modes close here: (i) an ERC20InsufficientBalance revert
        // inside `_resolve`, and (ii) the worse one — a SILENT UNCLEAN ADD. The vault routinely holds currency1
        // (token-side LP fees park in-vault by design awaiting `sweepTokenFees`), so if that parked balance
        // covers what the unclean add owes, the mint SUCCEEDS and permanently converts the token sink's money
        // into un-removable floor principal, with no revert and no distinguishing event. Abort cleanly instead.
        (, int24 tickNow,,) = stateView.getSlot0(_poolId());
        if (tickNow >= floorTickLower) {
            emit FloorMintAborted(tickNow);
            return 0;
        }

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
        // [H-5/P2] Book the EXACT principal consumed. `amt` rounds down inside getLiquidityForAmount0 and would
        // over-count the allowance ledger; fees were already realized by `_collect`, so this is pure principal.
        int128 a0 = delta.amount0();
        if (a0 < 0) bandQuoteWei += uint256(uint128(-a0));
        // currency0 is the floor's own working capital (ETH principal) → keep any positive delta in the vault.
        _resolve(currency0, a0, address(this));
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
