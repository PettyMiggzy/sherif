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
contract H5V3StyleVault is IUnlockCallback, ReentrancyGuard {
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

    // [V3-STYLE] The band is NO LONGER FIXED. A frozen deploy-anchored band is the root cause of H-5: any
    // successful gate bypass mints ETH at a launch-era price that no longer exists, which is exactly what the
    // attacker sells into. The live v3 Bond re-places its walls every poke, so manipulating the price
    // manipulates where the attacker's own money lands — self-defeating. These track the LAST band placed.
    int24 public floorTickLower;
    int24 public floorTickUpper;
    int24 public immutable anchorTick0; // launch tick, kept only as the initial band before any commit
    uint24 public immutable widthSpacings;

    // v3 Bond parity: refuse to act while spot is shoved away from the mean (Bond._requireUnmanipulated).
    int24 public constant MAX_DEV = 300; // ~3%, the shipped v3 value

    // Stand-in for the hook TWAP. Injected here so this variant measures the ECONOMICS of conservative
    // anchoring on its own; production would read a real oracle. Uniswap v3 gives pool.observe() for free and
    // v4 does not, so the real port needs an oracle in RobinFeeHook.
    int24 public meanTick;

    function setMeanTick(int24 t) external { meanTick = t; }

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
    /// [R3-H5 OPEN — see AUDIT-ROUND-3-EXTERNAL-ADDENDUM-2.md] The residual these constants could not close — a bounded slice force-committed off a
    /// stale `belowSince`, and its worse sustained-hold variant (measured +9.47 ETH, 83% of the carve drained,
    /// with NO keeper) — is closed by the SWAP-WITNESSED GATE, not by any of these values. See
    /// FLOOR-H5-CLOSURE-SPEC.md. The constants below are RETAINED UNCHANGED as subordinate AND-terms: they cost
    /// nothing, they keep the auditor's `COMMIT_COOLDOWN > MIN_DWELL` requirement a live referent, and every
    /// measured control stays in place.
    ///
    /// Why a TWAP is NOT the answer (and why this is not one): a time-weighted average is a DECAYING MEMORY, so
    /// after a genuine crash it keeps reading below-band for a bounded interval, and inside that interval the
    /// force-fill is fully atomic again. Measured: the naive TWAP conjunct made the attack STRICTLY BETTER for
    /// the attacker (peak +23.84 -> +31.92 ETH; break-even carve/depth ~30% -> 4.0%). Waiting is also free —
    /// a push->hold->sell-back round trip cost 1.110618 ETH at 0s of hold and 1.110618 ETH at 3h — so no gate
    /// priced in elapsed time can work. The gate below is priced in something the attacker cannot fake: an
    /// EXACT, swap-witnessed proof that the price was never above the band, where his own push is the swap that
    /// resets it.
    uint32 public constant MIN_DWELL = 10 minutes;
    uint16 public constant MAX_COMMIT_BPS = 2000; // ≤20% of the on-hand carve per commit
    // [R3-H5] MUST stay STRICTLY GREATER THAN MAX_OBSERVED_GAP. That inequality — not the one against MIN_DWELL —
    // is what bites: spacing commits beyond the observation gap forces the `nowTs > prevObserved + MAX_OBSERVED_GAP`
    // branch to RE-ARM `belowSince` before every commit, so the stale clock the forced-fill rides cannot survive
    // from one commit to the next. Measured on real contract code in
    // test/regression/H5.floor-forced-fill.test.js: shipped 10m ⇒ attacker +8.7340 ETH / 17.85 of a 20 ETH carve
    // consumed; 65m (this value) ⇒ attacker −0.2090 ETH, carve consumed 0.0000, floorLiquidity 0.
    // The external auditor instead recommended COMMIT_COOLDOWN > MIN_DWELL; that is INERT (bit-identical
    // +8.7340 ETH — the attacker is token-flat between commits, so waiting costs him nothing) and is NOT shipped.
    // HONEST SCOPE — [R3 N-A] READ THIS BEFORE TRUSTING THE GREEN TEST. This closes the TOKEN-FLAT round-trip
    // loop ONLY. It does NOT close, and barely paces, the SUSTAINED-HOLD variant: an attacker who pushes the tick
    // below the band ONCE, HOLDS it, and pokes on a cadence he chooses UNDER MAX_OBSERVED_GAP keeps `lastObserved`
    // fresh, so `belowSince` never re-arms and this constant is never consulted. Measured on THIS shipped vault
    // (H5.floor-forced-fill case 4): +10.4840 ETH over 8 commits, 16.64 of a 20 ETH carve consumed (83%).
    // Case 3's green is an artifact of a hard-coded >gap cadence that is attacker-UNFAVOURABLE — the attacker
    // picks the cadence, so do not read it as "the floor is fixed".
    // The real closure is NOT the TWAP-gated commit either (that was measured WORSE than shipping nothing:
    // holding is free per unit time, and a TWAP keeps reading below-band for a while after a genuine crash).
    // See FLOOR-H5-CLOSURE-SPEC.md for the surviving design; FLOOR-REDESIGN.md records the five refuted ones.
    // Honest-path cost: a keeper deploys the parked carve one 20% slice per 65 min instead of per 10 min.
    uint32 public constant COMMIT_COOLDOWN = 65 minutes;
    // [re-audit/H-5] If nobody has poked for longer than this, the dwell clock is UNTRUSTED and restarts (see addFloor).
    // Must exceed the honest keeper cadence (~COMMIT_COOLDOWN) so routine operation never resets, but bounds how stale
    // `belowSince` can get during an un-poked dump.
    uint32 public constant MAX_OBSERVED_GAP = 1 hours;
    uint16 internal constant BPS = 10_000;

    // ───────────────────── [R3-H5] the structural closure: P1 gate + P2 episode allowance ─────────────────────
    // Continuous, SWAP-WITNESSED, unaveraged below-band time required before any commit. The hook stamps
    // `aboveLowerTs` on every swap whose PRE-swap tick is at/above the band, so passing this proves the price was
    // below the band at EVERY instant of the window — the attacker's own push stamps it and shuts the gate in the
    // same transaction. 195 min = 3 x COMMIT_COOLDOWN (the external auditor's window requirement, literal).
    uint32 public constant MIN_BELOW_DURATION = 195 minutes;
    // Per-episode share of the band's size at episode start. g < 2*beta_net/G_max = 0.016; 0.005 gives 3.2x margin
    // against the "push down through a token-heavy band" lever (the attacker must refill it and pays fees on 2x
    // the notional to sweep it back).
    uint16 public constant EPISODE_BAND_BPS = 50; // 0.5%

    // Why a poke parked, for operators and tests.
    uint8 internal constant R_ORACLE = 1; // hook unreadable / unarmed / armed for a different band
    uint8 internal constant R_SPOT = 2; // live spot inside/above the band (settlement precondition)
    uint8 internal constant R_WARMUP = 3; // gate armed less than MIN_BELOW_DURATION ago
    uint8 internal constant R_BELOW = 4; // price was at/above the band too recently  <-- THE GATE
    uint8 internal constant R_DWELL = 5; // legacy poke dwell (retained, subordinate)
    uint8 internal constant R_COOLDOWN = 6; // legacy pace limiter (retained, unchanged)
    uint8 internal constant R_BUDGET = 7; // episode allowance exhausted

    uint64 public belowSince; // when the tick was first OBSERVED below the band (0 = last observation was not)
    uint64 public lastCommitAt; // when the last slice was committed
    uint64 public lastObserved; // block.timestamp of the last addFloor observation (any tick) — [re-audit/H-5] anti-stale

    // [R3-H5 P2] EPISODE = one continuous run of below-band price, identified by the hook watermark that opened
    // it. Within one episode the vault may commit at most EPISODE_BASE_WEI + EPISODE_BAND_BPS of the band's size
    // at episode start + every wei that ARRIVED during the episode. It does NOT refill with time — that is the
    // whole point: holding a manipulated price costs an attacker nothing per second (measured: a push->hold->
    // sell-back round trip cost the same at 0s and at 3h), so a time-refilling budget is free money. Anchoring
    // per episode prices the allowance against a ROUND TRIP instead.
    //
    // [R3 N-B] The anchor is the ABOVE-LOWER watermark, not an above-UPPER one. Anchoring on the upper edge left
    // a shallow dump that stalls inside the band unable to ever roll the episode, so the allowance accumulated
    // without bound in exactly the range where the force-fill is profitable. Anchoring on the lower edge means a
    // fresh allowance requires letting price back above the band — which also restarts MIN_BELOW_DURATION.
    uint64 public episodeAnchor; // the aboveLowerTs value that opened the current episode
    uint256 public episodeStartQuote; // parked carve when it opened
    uint256 public episodeStartBand; // bandQuoteWei when it opened
    uint256 public bandQuoteWei; // cumulative currency0 principal committed into the band (monotone)

    // Runbook value: seedQuoteWei / 10_000 (1 bp of pool depth). Derived from the LAUNCH CONFIG, never from a
    // chain read — a live-liquidity read is inflatable by a JIT straddle across the non-atomic launch->deploy gap.
    uint256 public immutable EPISODE_BASE_WEI;

    event FloorAdded(uint256 quoteUsed, uint128 liquidityAdded, uint128 totalLiquidity);
    event FloorSkipped(int24 currentTick, uint256 parked);
    event FloorParked(uint8 reason, int24 spot, uint256 parked); // [R3-H5] which gate layer refused
    event FloorEpisodeReset(uint64 anchor, uint256 startQuote, uint256 startBand);
    event FloorCommitted(uint256 quoteUsed, uint128 liquidityAdded, uint256 allowance, uint256 bandQuoteWei);
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
        uint24 bandWidthSpacings, // how many tickSpacings wide the wall is (>=1)
        uint256 episodeBaseWei // [R3-H5 P2] per-episode base allowance; runbook = seedQuoteWei / 10_000
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
        anchorTick0 = anchorTick;
        widthSpacings = bandWidthSpacings;
        EPISODE_BASE_WEI = episodeBaseWei;
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
        PoolId id = _poolId();
        (, int24 spot,,) = stateView.getSlot0(id);
        int24 mean = meanTick;

        // ── RULE 1 (v3 Bond `_requireUnmanipulated`) — refuse while the price is shoved. A shove large enough
        //    to move where the wall lands is larger than this tolerance, so it is simply not allowed to act.
        int24 dev = spot > mean ? spot - mean : mean - spot;
        if (dev > MAX_DEV) return _park(amt, spot, R_SPOT);

        if (block.timestamp < uint256(lastCommitAt) + COMMIT_COOLDOWN) return _park(amt, spot, R_COOLDOWN);

        // ── RULE 2 (v3 Bond conservative anchoring) — anchor to the side that makes pushing WORTHLESS. This is
        //    a single-sided currency0 BUY wall, which lives ABOVE spot in tick space (higher tick = cheaper
        //    token), so the conservative choice is the HIGHER tick — i.e. the LOWER price. Push spot down to
        //    fake a recovery and `max` falls back to the honest mean, so the wall does not follow. Push spot up
        //    and the wall is placed even cheaper, which is worse for the pusher. No profitable direction, and
        //    crucially NO DURATION TEST — nothing here asks how long the price has been anywhere.
        int24 anchor = spot > mean ? spot : mean;
        int24 lo = _alignUp(anchor + 1, tickSpacing);
        int24 hi = lo + int24(int256(uint256(widthSpacings))) * tickSpacing;
        if (hi <= lo || lo < TickMath.minUsableTick(tickSpacing) || hi > TickMath.maxUsableTick(tickSpacing)) {
            return _park(amt, spot, R_SPOT);
        }
        floorTickLower = lo;
        floorTickUpper = hi;

        uint256 slice = (amt * MAX_COMMIT_BPS) / BPS;
        if (slice == 0) slice = amt;
        added = abi.decode(poolManager.unlock(abi.encode(Op.ADD, slice)), (uint128));
        if (added > 0) lastCommitAt = uint64(block.timestamp);
        parkedQuote = currency0.balanceOfSelf();
        emit FloorCommitted(slice, added, 0, bandQuoteWei);
    }

    function _park(uint256 amt, int24 spot, uint8 reason) private returns (uint128) {
        parkedQuote = amt;
        emit FloorSkipped(spot, amt); // signature UNCHANGED — existing assertions keep working
        emit FloorParked(reason, spot, amt); // which layer said no
        return 0;
    }

    /// @dev Within one episode, cumulative band growth never exceeds the base + a share of the band at episode
    /// start + every wei that arrived during the episode. Cumulative inflow is DERIVABLE, never tracked:
    /// currency0 leaves this vault ONLY as a commit into the band (currency0 LP fees go straight to the platform
    /// inside _collect and never enter this balance; currency1 is an ERC20), so
    /// `cumInflow == balance + bandQuoteWei` and inflow this episode collapses to `amt - episodeStartQuote`.
    function _episodeAllowance(uint256 amt) internal view returns (uint256) {
        uint256 cap = EPISODE_BASE_WEI + (episodeStartBand * EPISODE_BAND_BPS) / BPS;
        if (amt >= episodeStartQuote) return cap + (amt - episodeStartQuote);
        uint256 spent = episodeStartQuote - amt; // cap already consumed this episode
        return spent >= cap ? 0 : cap - spent;
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
        bandQuoteWei += amt; // [R3-H5 P2] cumulative currency0 principal in the band; prices the episode allowance
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
