// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ICurvePadFactoryV4, LaunchConfig} from "../interfaces/ICurvePadFactoryV4.sol";
import {RobinV4FeeConfig} from "../core/RobinV4FeeConfig.sol";
import {PadValuation} from "../core/PadValuation.sol";
import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";

interface IRobinCurveGraduation {
    function ready() external view returns (bool);
    function graduate() external;
}

/// @title PresaleVault — a trustless, refundable ETH presale for a not-yet-launched Robin V4 curve
/// @notice One instance PER presale (EIP-1167 clone, initialize()-d atomically by the factory). A creator opens a
/// presale with a TARGET + DEADLINE + per-wallet cap; anyone deposits ETH and can REFUND in full any time the
/// presale fails. If the target is reached, `finalize()` launches the curve AND does the first curve buy ATOMICALLY
/// in one tx, and presalers pull their tokens PRO-RATA at the resulting curve price (plus a pro-rata refund of any
/// ETH the buy didn't spend). ETH NEVER touches the creator — it leaves the vault only as (a) the pooled curve buy,
/// (b) a refund/claim to the very depositor who put it in, or (c) the platform's PLATFORM_FEE_BPS cut of a raise
/// that SUCCEEDED, which is taken once in finalize() and pulled by withdrawPlatformFee(). A presale that fails
/// takes no cut at all: every refund is the whole deposit.
///
/// Trust model: no owner, no admin, no operator over the vault itself. The one address it defers to is the
/// destination of that platform cut, which it reads from FeeWalletRegistry — a contract with its own owner and a
/// 2-day timelock. Nothing else here is settable by anyone. Salts are COMMIT-REVEAL — only a preimage-holder (the creator, or
/// anyone they share it with) can finalize, so the freshly-launched pool is un-addressable until the reveal.
/// [M-22] The commitment is SINGLE-USE: the salts become PUBLIC the moment ANY `finalize` tx is mined — including a
/// REVERTED one, whose calldata is in block history forever, on any chain (a single-sequencer FCFS L2 with no public
/// mempool does NOT change this). So `finalize` checks the reveal FIRST (a wrong-salt poke can't leak a real
/// preimage), and once the real salts are on-chain `curvePadFactory.launch(cfg,salts)` is permissionless and anyone
/// can land the committed launch. finalize() is fail-safe against that: a sniped launch marks the presale Failed(3)
/// so 100% refunds open immediately — never a brick, a lock, or a theft. A caller who reveals the correct salts into
/// a premature `TargetNotMet` still burns the commitment (replay-resistance is a presale-terms decision, see M-22/
/// L-20) — so do NOT call `finalize` before the target is met. A FINALIZE_GRACE escape hatch converts to Failed if
/// finalize is never called. ETH can never be permanently trapped or stolen. Nothing in the audited
/// curve/hook/factory is modified.
contract PresaleVault is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice The platform's cut of a SUCCESSFUL raise, taken once at finalize. Never taken on a failed
    /// presale — a refund is always the full deposit. Constant, so a contributor can read the terms off the
    /// bytecode rather than trusting a setter.
    uint256 public constant PLATFORM_FEE_BPS = 1000; // 10%
    uint256 public constant MIN_TARGET = 0.01 ether;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 90 days;
    uint64 public constant GRACE_MIN = 1 hours;
    uint64 public constant GRACE_MAX = 7 days;
    uint256 internal constant BPS = 10_000; // the hook's buy-tax denominator
    uint256 internal constant PIPS = 1_000_000; // the pool's lpFee denominator
    // [L-12] Conservative gas floor for finalize()'s launch + pooled-buy. Guards against the EIP-150 63/64 rule
    // silently converting a fully-funded presale to an irreversible Failed(3) when finalize is called under-gassed.
    uint256 internal constant MIN_FINALIZE_GAS = 2_000_000;
    /// @notice [AUCTION] Dust added to the pooled buy REQUEST so it actually touches the graduation ceiling.
    /// `_absorbableIn` floors at every step, so it returns a LOWER bound and the buy stops a few wei of input
    /// short of `gradSqrt` — measured at exactly 3 wei on the reference geometry. Those few wei are the
    /// difference between a curve that graduates inside finalize and one that sits sold out waiting for a keeper
    /// that has never run in production (LIVE_DEPLOYMENT.md: 9 coins, 0 graduated).
    /// This CANNOT overshoot the ceiling: the swap is hard-limited at `gradSqrt`, so the pool stops there and
    /// `pooledEthSpent` measures what actually moved; the remainder stays in the vault and leaves through the
    /// same pro-rata ETH-back path as any other surplus. The only cost is [M-1]'s fee-on-requested-input applied
    /// to the unspent dust — at most `CEILING_REACH * buyTaxBps / BPS`, which is 0 wei at the shipped 1% rate
    /// and 1 wei at MAX_TAX_BPS (200 = 2%), the highest tax RobinV4FeeConfig permits.
    uint256 internal constant CEILING_REACH = 64;

    // ── immutable-after-initialize config ──
    ICurvePadFactoryV4 public curvePadFactory;
    IPoolManager public poolManager;
    LaunchConfig internal cfg; // exposed via launchConfig() (explicit getter → returns string members cleanly)
    bytes32 public saltCommitment; // keccak256(abi.encode(tokenSalt, hookSalt, curveSalt))
    /// @notice The DEPOSIT CEILING. Deposits are trimmed to it and it can never be exceeded.
    uint256 public target; // the hard cap
    /// @notice [AUCTION] The FINALIZE FLOOR — the least a raise may be and still launch. Split out of `target`,
    /// which used to be both cap and floor, so a raise that does not fill still becomes a live coin instead of a
    /// refund. Set it equal to `target` to reproduce the original all-or-nothing presale exactly.
    /// A partial raise may only finalize AFTER the deadline (see finalize), so splitting these does not hand the
    /// preimage-holder an option to close the raise early on the contributors who are still arriving.
    uint256 public minRaise;
    uint64 public deadline;
    uint64 public finalizeGrace;
    uint256 public perWalletCap;
    uint256 public minContribution;
    // [M-12] governed launch geometry snapshotted at initialize. The committed cfg carries NO geometry and
    // saltCommitment covers only the salts, so without this an in-cap `setDefaults` retune while the presale is OPEN
    // would silently reprice — or (at an unreachable graduation) brick — a fully-funded raise. finalize() refuses to
    // launch if the live defaults have moved from these.
    // [FDV] This is the RESOLVED start tick (cfg override if the creator set one, else the governed default at
    // open), NOT the raw default. A presale that pins its own launch price is unaffected by a later retune of the
    // global default, and one that inherits the default still tracks it — which is exactly what M-12 wants.
    int24 public snapStartTickMag;
    int24 public snapCurveWidth;
    uint24 public snapLpFee;

    // ── mutable state ──
    bool public initialized;
    bool public finalized;
    bool public failed;
    bool private _expectingUnlock; // gates unlockCallback to a finalize the vault itself initiated
    /// @dev [AUCTION] Open ONLY across the inline `graduate()` call in finalize. The curve pays its graduation
    /// keeper bounty to `msg.sender` — this vault — and the vault otherwise has no `receive()`, so without this
    /// the send would fail and the bounty would be booked to `gasBountyOwed[vault]` on the curve and stranded
    /// there forever (nothing here can call `claimGasBounty`). Kept to a single call frame so accepting the
    /// bounty does not open a general donation surface: ETH that arrives at any other time still reverts, and no
    /// new way to strand value in this vault is created.
    bool private _gradInFlight;

    uint256 public totalRaised;
    uint64 public filledAt; // [L-13] block.timestamp the raise first reached target (0 until then); anchors the grace window
    address public token;
    uint256 public totalTokensBought;
    uint256 public pooledEthSpent;
    /// @notice The platform's cut, fixed at finalize. This is ACCOUNTING and never changes afterwards, because
    /// `_payout` SUBTRACTS it from the leftover ETH pool (the divisor there is `totalRaised`). Zeroing it on
    /// withdrawal would silently inflate every unclaimed contributor's ETH-back against a vault that no longer
    /// holds the money — the early claimers would drain the buy proceeds and the last one would revert.
    uint256 public platformFee;
    /// @notice Whether that cut has been pulled yet. Separate from the amount for exactly the reason above.
    bool public platformFeePaid;
    /// @notice [AUCTION] The graduation keeper bounty the curve paid this vault during inline graduation.
    /// Platform-bound like `platformFee`, but kept in a SEPARATE book because `_payout` SUBTRACTS `platformFee`
    /// from the contributors' ETH-back pool. This money was never contributor money — it arrived from the curve
    /// after the raise was already accounted — so subtracting it would shrink every contributor's refund by the
    /// bounty AND still leave the bounty itself stranded, because the pool it was deducted from is not where it
    /// physically sits. Booked separately, the vault's outflows sum to its holdings exactly.
    uint256 public platformBounty;

    mapping(address => uint256) public contribution;
    mapping(address => bool) public claimed;
    address[] public depositors;

    event Initialized(address indexed creator, uint256 target, uint64 deadline);
    event Deposited(address indexed user, uint256 amount, uint256 refundedTrim);
    event Finalized(address indexed token, address indexed curve, PoolId poolId, uint256 pooledEthSpent, uint256 tokensBought);
    event Claimed(address indexed user, uint256 tokenOut, uint256 ethBack);
    event PlatformFeePaid(address indexed to, uint256 amount);
    event Failed(uint8 reason); // 1 = under target at deadline, 2 = grace escape hatch, 3 = committed launch sniped
    event Refunded(address indexed user, uint256 amount);

    error NotOpen();
    error AfterDeadline();
    error BeforeDeadline();
    error TargetNotMet();
    error TargetMet();
    error AlreadyInitialized();
    error AlreadyClaimed();
    error NothingToClaim();
    error BelowMin();
    error CapExceeded();
    error NotPoolManager();
    error UnexpectedUnlock();
    error EthSendFailed();
    error NotFinalized();
    error NotFailed();
    error BadReveal();
    error KeyMismatch();
    error ZeroBought();
    error BadParams();
    error InsufficientGas();
    error LaunchReverted();
    error GeometryChanged();

    /// @notice One-shot initializer, called by the factory in the creation tx (clones have no constructor args).
    function initialize(
        address curvePadFactory_,
        LaunchConfig calldata cfg_,
        bytes32 saltCommitment_,
        uint256 target_,
        uint256 minRaise_,
        uint64 deadline_,
        uint256 perWalletCap_,
        uint256 minContribution_,
        uint64 finalizeGrace_
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (
            curvePadFactory_ == address(0) || saltCommitment_ == bytes32(0) || target_ < MIN_TARGET
                // [AUCTION] the floor is a real raise and can never exceed the cap; minRaise_ == target_ is the
                // original all-or-nothing presale, minRaise_ == MIN_TARGET is the no-failed-launch auction.
                || minRaise_ < MIN_TARGET || minRaise_ > target_
                || perWalletCap_ == 0 || minContribution_ == 0 || minContribution_ > target_
                || minContribution_ > perWalletCap_ // [L-21] else every deposit reverts (below floor → BelowMin, at/above → CapExceeded)
                || deadline_ < block.timestamp + MIN_DURATION || deadline_ > block.timestamp + MAX_DURATION
                || finalizeGrace_ < GRACE_MIN || finalizeGrace_ > GRACE_MAX
        ) revert BadParams();
        initialized = true;
        curvePadFactory = ICurvePadFactoryV4(curvePadFactory_);
        poolManager = IPoolManager(curvePadFactory.poolManager());
        cfg = cfg_;
        // [M-12] snapshot the governed geometry the contributors are committing to
        RobinV4FeeConfig.Defaults memory d0 = RobinV4FeeConfig(curvePadFactory.feeConfig()).defaults();
        snapStartTickMag = PadValuation.startTickOf(cfg_.startTickMag, d0.startTickMag);
        snapCurveWidth = d0.curveWidth;
        snapLpFee = uint24(d0.lpFee);
        // [FDV] Fail HERE, not at finalize. The factory bounds supply x launch price, so a presale opened with an
        // out-of-band valuation can take deposits for its whole duration and then hit `MarketCapOutOfRange` inside
        // `finalize`'s try/catch — which refunds everyone (safe) but burns the raise and mislabels it Failed(3)
        // "sniped". Checking the same band at open turns a creator's arithmetic mistake into a failed transaction.
        // (This is best-effort, not a guarantee: the band is a live governance knob and can move mid-presale.)
        uint256 fdv0 = PadValuation.fdvWei(cfg_.supply, snapStartTickMag);
        if (fdv0 < d0.minFdvWei || fdv0 > d0.maxFdvWei) revert BadParams();
        saltCommitment = saltCommitment_;
        target = target_;
        minRaise = minRaise_;
        deadline = deadline_;
        perWalletCap = perWalletCap_;
        minContribution = minContribution_;
        finalizeGrace = finalizeGrace_;
        emit Initialized(cfg_.creator, target_, deadline_);
    }

    // ── deposit ────────────────────────────────────────────────────────────────────

    /// @notice Contribute ETH to the presale. Trimmed to the remaining gap to target; the surplus is refunded in
    /// the same tx. The minContribution floor is checked against your INTENT (msg.value), so the last sliver of the
    /// raise is always fillable and minContribution can never strand the presale below target.
    function deposit() external payable nonReentrant {
        if (finalized || failed) revert NotOpen();
        if (block.timestamp >= deadline) revert AfterDeadline();
        if (msg.value < minContribution) revert BelowMin();

        uint256 room = target - totalRaised; // target == hardCap
        uint256 accept = msg.value < room ? msg.value : room;
        if (accept == 0) revert TargetMet();
        if (contribution[msg.sender] + accept > perWalletCap) revert CapExceeded();

        // CEI: books first, external refund last
        if (contribution[msg.sender] == 0) depositors.push(msg.sender);
        contribution[msg.sender] += accept;
        totalRaised += accept;
        // [L-13] stamp the instant the raise closes (target == hardCap, so this fires exactly once), anchoring the
        // finalize grace window to when the raise actually filled — not to an arbitrary far-off deadline.
        if (filledAt == 0 && totalRaised == target) filledAt = uint64(block.timestamp);

        uint256 refundTrim = msg.value - accept;
        if (refundTrim > 0) {
            (bool ok,) = payable(msg.sender).call{value: refundTrim}("");
            if (!ok) revert EthSendFailed();
        }
        emit Deposited(msg.sender, accept, refundTrim);
    }

    // ── finalize (success) ───────────────────────────────────────────────────────────

    /// @notice Launch the curve and do the pooled first buy atomically, if the target is met. Permissionless among
    /// preimage-holders (the salts commit-reveal). CEI: flips `finalized` before any external call.
    function finalize(bytes32 tokenSalt, bytes32 hookSalt, bytes32 curveSalt) external nonReentrant {
        // [M-22] Check the reveal FIRST. A reverted tx is still mined and its calldata is public forever, so any
        // call that trips a later guard would ALREADY have published the salt preimage on-chain — defeating the
        // commit-reveal on any chain, mempool or not. Ordering BadReveal first means a call bearing WRONG salts
        // (garbage/poke) reverts without a correct preimage ever having been compared, so it cannot leak one.
        // (This does not save a caller who reveals the CORRECT salts into a premature TargetNotMet — that residual
        // needs replay-resistance, a presale-terms decision left for the operator; see M-22 / L-20 in the ledger.)
        if (keccak256(abi.encode(tokenSalt, hookSalt, curveSalt)) != saltCommitment) revert BadReveal();
        if (finalized || failed) revert NotOpen();
        if (totalRaised < minRaise) revert TargetNotMet();
        // [AUCTION] A raise that has NOT filled the cap may only launch once the deadline has passed. Without this
        // the preimage-holder could finalize the instant `minRaise` was crossed and settle the raise on top of every
        // contributor still arriving — the split between floor and cap must not become an early-close option.
        // A FULL raise still finalizes immediately, exactly as before.
        if (totalRaised < target && block.timestamp < deadline) revert BeforeDeadline();
        // [L-20] The preimage-holder's launch option EXPIRES at the end of the grace window, so finalize and the
        // Failed(2) escape hatch are never both live: past this point only fail() reason 2 (100% refunds) is
        // reachable, giving L-13's contributor lock a hard ceiling.
        // [AUCTION] Anchored to filledAt when the raise FILLED, else to the deadline — a partial raise never
        // stamps filledAt, and anchoring it at 0 would put the whole window in the past and make finalize
        // permanently unreachable while fail() reason 2 refunded a raise that was entitled to launch.
        if (block.timestamp > _finalizeAnchor() + finalizeGrace) revert AfterDeadline();
        // [L-12] Guarantee enough gas for launch + the pooled buy BEFORE flipping state, so an under-gassed call can
        // never let the EIP-150 63/64 rule brick the atomic launch and silently convert a funded presale to Failed(3).
        if (gasleft() < MIN_FINALIZE_GAS) revert InsufficientGas();
        // [M-12] refuse to finalize if the governed geometry moved since the presale opened — contributors committed
        // to the snapshot, and an in-cap setDefaults retune must not silently reprice or brick their funded raise.
        // (Reverting keeps the presale OPEN; if the operator won't restore the geometry, fail() reason 2 refunds 100%.)
        RobinV4FeeConfig.Defaults memory d0 = RobinV4FeeConfig(curvePadFactory.feeConfig()).defaults();
        if (
            PadValuation.startTickOf(cfg.startTickMag, d0.startTickMag) != snapStartTickMag
                || d0.curveWidth != snapCurveWidth || uint24(d0.lpFee) != snapLpFee
        ) {
            revert GeometryChanged();
        }
        finalized = true;

        // launch: deploys token+hook+curve, inits the pool at startTick, seeds the single-sided curve. Takes NO ETH
        // seed and pays the creator NO remainder (no-mint) — the creator profits only via the sell-tax stream +
        // graduation share, never presale ETH.
        LaunchConfig memory c = cfg;
        address tok;
        address hook;
        address curve;
        PoolId poolId;
        try curvePadFactory.launch(c, tokenSalt, hookSalt, curveSalt) returns (address a, address b, address cc, PoolId pid) {
            (tok, hook, curve, poolId) = (a, b, cc, pid);
        } catch (bytes memory reason) {
            // [audit] The committed launch was SNIPED — curvePadFactory.launch(cfg, salts) is permissionless and fully
            // determined by the public cfg + the just-revealed salts, so a front-runner can launch (and buy) it first,
            // after which this re-entry reverts with a TYPED error (registerPool AlreadyRegistered / PoolAlreadyInitialized
            // / the drained factory's SafeERC20 seed-transfer failure). Rather than revert — which would lock
            // contributors for the whole finalizeGrace window (fail() reason 2) — FAIL the presale NOW so 100% refunds
            // open immediately. On Robinhood Chain's single-sequencer FCFS ordering this is not reachable; it exists so
            // a public-mempool / decentralized-sequencer deployment can never brick the vault or trap contributor ETH.
            // [L-12] An EMPTY revert (no error data) is the signature of an out-of-gas / unexpected failure, NOT a
            // deterministic launch-collision — bubble it (finalize stays retriable, state rolled back) instead of
            // irreversibly burning a funded presale to Failed(3). The MIN_FINALIZE_GAS floor above already excludes
            // the common under-gas cause; this guards the deep-call 1/64 residue.
            if (reason.length == 0) revert LaunchReverted();
            finalized = false;
            failed = true;
            emit Failed(3); // 3 = committed launch sniped / front-run
            return;
        }
        token = tok;

        // reconstruct the pool key from the SAME feeConfig read the factory just used (same tx ⇒ identical)
        RobinV4FeeConfig.Defaults memory d = RobinV4FeeConfig(curvePadFactory.feeConfig()).defaults();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tok),
            fee: uint24(d.lpFee),
            tickSpacing: c.tickSpacing,
            hooks: IHooks(hook)
        });
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert KeyMismatch();
        // [FDV] the SAME resolution the factory just used to initialize the pool — a per-launch start tick must
        // reach the buy sizing below, or the pooled buy would be priced off a tick the pool never launched at.
        int24 startTick = PadValuation.startTickOf(c.startTickMag, d.startTickMag);
        int24 gradTick = startTick - d.curveWidth;
        uint160 gradSqrt = TickMath.getSqrtPriceAtTick(gradTick);

        // [M-1] The pooled buy is ONE exact-input swap price-limited at the protocol's own graduation ceiling,
        // and the hook charges buyTaxBps on the REQUESTED input regardless of how much actually executes. A
        // target larger than the curve's capacity therefore taxed the WHOLE raise to fill a sliver of it, and
        // socialised that over-charge pro-rata across every contributor. Size the request to what this curve
        // can absorb; the surplus never enters the swap and leaves through the pro-rata ETH-back path that
        // `pooledEthSpent` already drives.
        // The platform's cut comes off the top of a raise that SUCCEEDED, so it never touches a refund path:
        // fail() leaves platformFee at zero and every deposit comes back whole. `totalRaised` is left
        // untouched because it is the pro-rata denominator every contributor is measured against — the fee is
        // subtracted from what the buy may spend, and again from the ETH-back pool in _claim.
        // [AUCTION] The cut is taken on the slice of the raise that is actually DEPLOYED, not on the whole raise.
        // [M-1] already stopped the over-CAPACITY part of a raise from being taxed inside the swap, but the
        // platform's 10% was still charged on `totalRaised` — so ETH that never reached the curve, and came
        // straight back to the contributor through the pro-rata ETH-back path, was charged a launch fee anyway.
        // Gross the curve's capacity back up through the fee that comes off the top to get the slice of the raise
        // that can actually be put to work; everything beyond it is returned WHOLE.
        uint256 capacity =
            _absorbableIn(TickMath.getSqrtPriceAtTick(startTick), gradSqrt, c.curveSupply, d.lpFee, d.buyTaxBps);
        // The most this buy should ever REQUEST: the curve's capacity plus the dust that carries it onto the
        // ceiling. Everything past this is raise the curve cannot take, and it goes back whole.
        uint256 reach = capacity == 0 ? 0 : capacity + CEILING_REACH;
        // ...bounded by what the raise can afford once the platform's cut is reserved. Reserving the MAXIMUM
        // possible cut here (10% of the whole raise) rather than the eventual one keeps this a pure upper bound:
        // the real cut is measured after the swap, and is never larger than this.
        uint256 budget = totalRaised - (totalRaised * PLATFORM_FEE_BPS) / BPS;
        uint256 amtIn = reach < budget ? reach : budget;
        if (amtIn == 0) revert ZeroBought();

        // pooled buy, atomic with the launch
        uint256 balBefore = IERC20(tok).balanceOf(address(this));
        _expectingUnlock = true;
        poolManager.unlock(abi.encode(amtIn, key, gradSqrt));
        _expectingUnlock = false;

        totalTokensBought = IERC20(tok).balanceOf(address(this)) - balBefore; // measured, hook-net
        if (totalTokensBought == 0) revert ZeroBought();

        // [AUCTION] The platform's cut is MEASURED on what the curve actually took, after the fact — never
        // forecast. `_absorbableIn` is a gross-up estimate and the swap can stop short of it at the price limit,
        // so charging 10% of an estimate would tax capital that was requested but never deployed, which is the
        // same defect one layer down. `pooledEthSpent` is the exact figure, so the cut is exactly a ninth of it:
        // 10% of (deployed + cut). Everything the curve did not take goes back to contributors WHOLE.
        // Bounded by construction: pooledEthSpent <= amtIn <= totalRaised - 10% of totalRaised, so
        // platformFee + pooledEthSpent <= totalRaised and _payout's subtraction can never underflow.
        platformFee = (pooledEthSpent * PLATFORM_FEE_BPS) / (BPS - PLATFORM_FEE_BPS);

        // [AUCTION] If the pooled buy filled the curve outright, GRADUATE in this same transaction. A raise big
        // enough to absorb the whole curve has already done all the price discovery there is, and leaving the
        // coin sitting on a sold-out curve waiting for a keeper is the state the live v3 stack has never gotten
        // out of (LIVE_DEPLOYMENT.md: 9 coins, 0 graduated, graduation keeper mandatory).
        // Non-bricking on purpose: graduation is a large external call into the curve, the LockVault and the
        // PositionManager, and none of it may be allowed to undo a raise that has already succeeded. If it
        // reverts the presale is still finalized, claims still work, and `graduate()` stays permissionless for
        // anyone to land afterwards. Guarded by a code check first because a codeless address would revert the
        // typed call UNCAUGHT by try/catch.
        if (curve.code.length > 0) {
            uint256 balBeforeGrad = address(this).balance;
            _gradInFlight = true;
            try IRobinCurveGraduation(curve).ready() returns (bool r) {
                if (r) {
                    try IRobinCurveGraduation(curve).graduate() {} catch {}
                }
            } catch {}
            _gradInFlight = false;
            // The curve pays its graduation keeper bounty to whoever triggered it — us. Book it to the platform
            // rather than letting it sit: contributor payouts are computed from fixed accounting, never from this
            // balance, so an unbooked wei here would be stranded for the life of the vault.
            // Book it SEPARATELY from platformFee — see platformBounty. Folding it into platformFee would
            // deduct it from the contributors' ETH-back pool, which is not where it came from.
            platformBounty = address(this).balance - balBeforeGrad;
        }

        emit Finalized(tok, curve, poolId, pooledEthSpent, totalTokensBought);
    }

    /// @dev [AUCTION] The instant the finalize window starts counting: when the raise FILLED the cap if it ever
    /// did, otherwise the deadline. `fail()` reads the same helper, so the launch option and the Failed(2)
    /// escape hatch open and close on exactly the same boundary and are never both live.
    function _finalizeAnchor() internal view returns (uint256) {
        return filledAt != 0 ? uint256(filledAt) : uint256(deadline);
    }

    /// @notice ETH is accepted ONLY across the inline graduation call in finalize, where the curve pays this
    /// vault the graduation keeper bounty. Every other send reverts, so this does not become a way for anyone to
    /// strand value here — contributor payouts are driven by fixed accounting, not by this contract's balance.
    receive() external payable {
        if (!_gradInFlight) revert EthSendFailed();
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_expectingUnlock) revert UnexpectedUnlock();
        (uint256 amtIn, PoolKey memory key, uint160 gradSqrt) = abi.decode(data, (uint256, PoolKey, uint160));
        BalanceDelta sd = poolManager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(amtIn), sqrtPriceLimitX96: gradSqrt}),
            ""
        );
        uint256 ethOwed = uint256(uint128(-sd.amount0())); // ETH the vault owes the pool (<= amtIn)
        uint256 tokenOut = uint256(uint128(sd.amount1())); // token credited to the vault, net of the hook skim
        poolManager.settle{value: ethOwed}();
        poolManager.take(key.currency1, address(this), tokenOut);
        pooledEthSpent = ethOwed; // the rest of totalRaised stays in the vault for the pro-rata ETH-back
        return "";
    }

    /// @dev [M-1] The largest exact-input BUY this freshly-launched curve can absorb before spot reaches the
    /// graduation ceiling, grossed up for the two cuts taken off the input before any of it reaches the reserve:
    /// the hook's buyTaxBps (fee-on-REQUESTED-input, skimmed in beforeSwap) and then the pool's lpFee.
    /// Deterministic inside this transaction: the factory has just initialized the pool AT startTick and seeded
    /// exactly `curveSupply` as one token-only range [gradTick, startTick], so L — and the amount0 needed to walk
    /// startTick down to gradTick — are exact, not estimated. Third-party liquidity planted anywhere in the band
    /// only ADDS capacity, so a griefer cannot make this over-shoot.
    /// Every step floors, so the result is a lower bound on true capacity up to a couple of wei at the knife
    /// edge where the exact amount0 divides evenly. That residue is harmless: the over-charge it could leave is
    /// floor(2 * buyTaxBps / 10000) == 0 wei at every permitted tax rate.
    function _absorbableIn(uint160 startSqrt, uint160 gradSqrt, uint256 curveSupply, uint24 lpFee, uint16 buyTaxBps)
        internal
        pure
        returns (uint256 amtIn)
    {
        uint128 L = LiquidityAmounts.getLiquidityForAmount1(gradSqrt, startSqrt, curveSupply);
        // defence only: L == 0 would already have failed the launch, buyTaxBps is capped at MAX_TAX_BPS, and
        // lpFee == PIPS is a permitted config boundary that would panic on a bare subtraction.
        if (L == 0 || lpFee >= PIPS || buyTaxBps >= BPS) return 0;
        amtIn = SqrtPriceMath.getAmount0Delta(gradSqrt, startSqrt, L, false); // ETH into the reserve, round DOWN
        // Order matters: the hook skims FIRST and hands the pool `request - fee`, which the pool then charges
        // lpFee on. Gross up in that same order, innermost cut first.
        amtIn = Math.mulDiv(amtIn, PIPS, PIPS - lpFee);
        amtIn = Math.mulDiv(amtIn, BPS, BPS - buyTaxBps);
    }

    // ── claim (after success) ─────────────────────────────────────────────────────────

    /// @notice Pull your pro-rata tokens (+ pro-rata refund of unspent ETH). One-shot.
    function claim() external nonReentrant {
        _claim(msg.sender, msg.sender);
    }

    /// @notice Same as claim() but routes BOTH the token and the ETH to `to` (for a contract contributor that
    /// reverts on a plain ETH receive). Value still only ever goes where the contributor directs.
    function claimTo(address to) external nonReentrant {
        if (to == address(0)) revert BadParams();
        _claim(msg.sender, to);
    }

    /// @notice Pay the platform's accrued cut to the wallet the fee registry names right now. Permissionless —
    /// the destination is not a parameter, so a caller can only push the platform's own money to the platform.
    /// Pull rather than push because a wallet that reverts on receive would otherwise revert `finalize` and
    /// convert a fully-funded raise into a Failed presale.
    function withdrawPlatformFee() external nonReentrant {
        uint256 amt = platformFee + platformBounty; // [AUCTION] the cut plus any inline-graduation bounty
        if (amt == 0 || platformFeePaid) return;
        platformFeePaid = true; // CEI — the FLAG is what guards the re-entry, not the amount
        address to = IFeeWalletRegistry(curvePadFactory.feeRegistry()).platformFeeWallet();
        if (to == address(0)) revert BadParams();
        (bool ok,) = payable(to).call{value: amt}("");
        if (!ok) revert EthSendFailed();
        emit PlatformFeePaid(to, amt);
    }

    /// @dev The ONE place a contributor's payout is computed. `previewClaim` and `_claim` both route through
    /// here so the number a user is shown and the number they are paid can never drift apart — they did once,
    /// when the platform fee was subtracted in the claim path and not the preview.
    function _payout(uint256 c) internal view returns (uint256 tokenOut, uint256 ethBack) {
        tokenOut = Math.mulDiv(c, totalTokensBought, totalRaised);
        // The platform's cut is out of the vault's economics entirely: it is neither swapped nor returned.
        ethBack = Math.mulDiv(c, totalRaised - pooledEthSpent - platformFee, totalRaised);
    }

    function _claim(address user, address to) internal {
        if (!finalized) revert NotFinalized();
        uint256 c = contribution[user];
        if (c == 0) revert NothingToClaim();
        if (claimed[user]) revert AlreadyClaimed();
        claimed[user] = true; // CEI

        (uint256 tokenOut, uint256 ethBack) = _payout(c);
        IERC20(token).safeTransfer(to, tokenOut);
        if (ethBack > 0) {
            (bool ok,) = payable(to).call{value: ethBack}("");
            if (!ok) revert EthSendFailed();
        }
        emit Claimed(user, tokenOut, ethBack);
    }

    // ── fail / refund ────────────────────────────────────────────────────────────────

    /// @notice Move the presale to Failed if it can no longer succeed: (1) past the deadline under target, or (2)
    /// [L-13] past filledAt+grace with the target met but not finalized (escape hatch — finalize was withheld or
    /// bricked). Anchoring (2) to when the raise CLOSED, not the deadline, means an early-filled raise's contributors
    /// aren't locked until a far-off deadline. Permissionless.
    function fail() external nonReentrant {
        if (finalized || failed) revert NotOpen();
        if (totalRaised < minRaise) {
            // [AUCTION] Below the FLOOR the raise can never launch, so it fails at the deadline exactly as
            // before. With minRaise == MIN_TARGET this branch is all but unreachable, which is the point of the
            // no-failed-launch setting — but it is deliberately kept, because it is the path that makes the
            // "contributor ETH is never trapped" invariant true, and deleting it would make that claim false.
            if (block.timestamp <= deadline) revert BeforeDeadline();
            failed = true;
            emit Failed(1);
        } else {
            // [L-13] target met: the escape hatch is anchored to when the raise CLOSED (filledAt), not the arbitrary
            // deadline, so an EARLY-filled raise isn't locked until a far-off deadline+grace. filledAt is guaranteed
            // set here (target is reachable only via deposit(), which stamps it) and is always <= deadline (deposits
            // revert past the deadline). Matches finalize()'s [L-20] upper bound: exactly one of the two is ever live.
            if (block.timestamp > _finalizeAnchor() + finalizeGrace) {
                failed = true;
                emit Failed(2);
            } else {
                revert TargetMet(); // target met, within grace → must finalize, not fail
            }
        }
    }

    /// @notice Reclaim 100% of your contribution after the presale failed. One-shot.
    function refund() external nonReentrant {
        _refund(msg.sender);
    }

    /// @notice Same as refund() but routes the ETH to `to` — the fail-path mirror of claimTo(), so a contract
    /// contributor that reverts on a plain ETH receive can still be made whole (upholds the "ETH is never trapped"
    /// invariant). Value still only ever goes where the depositor directs.
    function refundTo(address to) external nonReentrant {
        if (to == address(0)) revert BadParams();
        _refund(to);
    }

    function _refund(address to) internal {
        if (!failed) revert NotFailed();
        uint256 c = contribution[msg.sender];
        if (c == 0) revert NothingToClaim();
        if (claimed[msg.sender]) revert AlreadyClaimed();
        claimed[msg.sender] = true; // CEI (shared with claim → a user extracts value at most once)
        (bool ok,) = payable(to).call{value: c}("");
        if (!ok) revert EthSendFailed();
        emit Refunded(msg.sender, c);
    }

    // ── views ────────────────────────────────────────────────────────────────────────

    function previewClaim(address user) external view returns (uint256 tokenOut, uint256 ethBack) {
        uint256 c = contribution[user];
        if (c == 0 || !finalized || claimed[user]) return (0, 0);
        (tokenOut, ethBack) = _payout(c);
    }

    /// @notice 0 = Open, 1 = Launched, 2 = Failed.
    function state() external view returns (uint8) {
        if (finalized) return 1;
        if (failed) return 2;
        return 0;
    }

    function depositorCount() external view returns (uint256) {
        return depositors.length;
    }
}
