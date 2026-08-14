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

/// @title PresaleVault — a trustless, refundable ETH presale for a not-yet-launched Robin V4 curve
/// @notice One instance PER presale (EIP-1167 clone, initialize()-d atomically by the factory). A creator opens a
/// presale with a TARGET + DEADLINE + per-wallet cap; anyone deposits ETH and can REFUND in full any time the
/// presale fails. If the target is reached, `finalize()` launches the curve AND does the first curve buy ATOMICALLY
/// in one tx, and presalers pull their tokens PRO-RATA at the resulting curve price (plus a pro-rata refund of any
/// ETH the buy didn't spend). ETH NEVER touches the creator — it leaves the vault only as (a) the pooled curve buy
/// or (b) a refund/claim to the very depositor who put it in.
///
/// Trust model: no owner, no admin, no operator. Salts are COMMIT-REVEAL — only a preimage-holder (the creator, or
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

    uint256 public constant MIN_TARGET = 0.01 ether;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    uint64 public constant GRACE_MIN = 1 hours;
    uint64 public constant GRACE_MAX = 7 days;
    uint256 internal constant BPS = 10_000; // the hook's buy-tax denominator
    uint256 internal constant PIPS = 1_000_000; // the pool's lpFee denominator
    // [L-12] Conservative gas floor for finalize()'s launch + pooled-buy. Guards against the EIP-150 63/64 rule
    // silently converting a fully-funded presale to an irreversible Failed(3) when finalize is called under-gassed.
    uint256 internal constant MIN_FINALIZE_GAS = 2_000_000;

    // ── immutable-after-initialize config ──
    ICurvePadFactoryV4 public curvePadFactory;
    IPoolManager public poolManager;
    LaunchConfig internal cfg; // exposed via launchConfig() (explicit getter → returns string members cleanly)
    bytes32 public saltCommitment; // keccak256(abi.encode(tokenSalt, hookSalt, curveSalt))
    uint256 public target; // == hardCap
    uint64 public deadline;
    uint64 public finalizeGrace;
    uint256 public perWalletCap;
    uint256 public minContribution;
    // [M-12] governed launch geometry snapshotted at initialize. The committed cfg carries NO geometry and
    // saltCommitment covers only the salts, so without this an in-cap `setDefaults` retune while the presale is OPEN
    // would silently reprice — or (at an unreachable graduation) brick — a fully-funded raise. finalize() refuses to
    // launch if the live defaults have moved from these.
    int24 public snapStartTickMag;
    int24 public snapCurveWidth;
    uint24 public snapLpFee;

    // ── mutable state ──
    bool public initialized;
    bool public finalized;
    bool public failed;
    bool private _expectingUnlock; // gates unlockCallback to a finalize the vault itself initiated

    uint256 public totalRaised;
    uint64 public filledAt; // [L-13] block.timestamp the raise first reached target (0 until then); anchors the grace window
    address public token;
    uint256 public totalTokensBought;
    uint256 public pooledEthSpent;

    mapping(address => uint256) public contribution;
    mapping(address => bool) public claimed;
    address[] public depositors;

    event Initialized(address indexed creator, uint256 target, uint64 deadline);
    event Deposited(address indexed user, uint256 amount, uint256 refundedTrim);
    event Finalized(address indexed token, address indexed curve, PoolId poolId, uint256 pooledEthSpent, uint256 tokensBought);
    event Claimed(address indexed user, uint256 tokenOut, uint256 ethBack);
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
        uint64 deadline_,
        uint256 perWalletCap_,
        uint256 minContribution_,
        uint64 finalizeGrace_
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (
            curvePadFactory_ == address(0) || saltCommitment_ == bytes32(0) || target_ < MIN_TARGET
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
        snapStartTickMag = d0.startTickMag;
        snapCurveWidth = d0.curveWidth;
        snapLpFee = uint24(d0.lpFee);
        saltCommitment = saltCommitment_;
        target = target_;
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
        if (totalRaised < target) revert TargetNotMet();
        // [L-20] The preimage-holder's launch option EXPIRES at the end of the grace window (anchored to filledAt,
        // like fail()'s reason-2 hatch below), so finalize and the Failed(2) escape hatch are never both live: past
        // this point only fail() reason 2 (100% refunds) is reachable, giving L-13's contributor lock a hard ceiling.
        if (block.timestamp > uint256(filledAt) + finalizeGrace) revert AfterDeadline();
        // [L-12] Guarantee enough gas for launch + the pooled buy BEFORE flipping state, so an under-gassed call can
        // never let the EIP-150 63/64 rule brick the atomic launch and silently convert a funded presale to Failed(3).
        if (gasleft() < MIN_FINALIZE_GAS) revert InsufficientGas();
        // [M-12] refuse to finalize if the governed geometry moved since the presale opened — contributors committed
        // to the snapshot, and an in-cap setDefaults retune must not silently reprice or brick their funded raise.
        // (Reverting keeps the presale OPEN; if the operator won't restore the geometry, fail() reason 2 refunds 100%.)
        RobinV4FeeConfig.Defaults memory d0 = RobinV4FeeConfig(curvePadFactory.feeConfig()).defaults();
        if (d0.startTickMag != snapStartTickMag || d0.curveWidth != snapCurveWidth || uint24(d0.lpFee) != snapLpFee) {
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
        int24 startTick = int24(d.startTickMag);
        int24 gradTick = startTick - d.curveWidth;
        uint160 gradSqrt = TickMath.getSqrtPriceAtTick(gradTick);

        // [M-1] The pooled buy is ONE exact-input swap price-limited at the protocol's own graduation ceiling,
        // and the hook charges buyTaxBps on the REQUESTED input regardless of how much actually executes. A
        // target larger than the curve's capacity therefore taxed the WHOLE raise to fill a sliver of it, and
        // socialised that over-charge pro-rata across every contributor. Size the request to what this curve
        // can absorb; the surplus never enters the swap and leaves through the pro-rata ETH-back path that
        // `pooledEthSpent` already drives.
        uint256 amtIn =
            _absorbableIn(TickMath.getSqrtPriceAtTick(startTick), gradSqrt, c.curveSupply, d.lpFee, d.buyTaxBps);
        if (amtIn > totalRaised) amtIn = totalRaised;
        if (amtIn == 0) revert ZeroBought();

        // pooled buy, atomic with the launch
        uint256 balBefore = IERC20(tok).balanceOf(address(this));
        _expectingUnlock = true;
        poolManager.unlock(abi.encode(amtIn, key, gradSqrt));
        _expectingUnlock = false;

        totalTokensBought = IERC20(tok).balanceOf(address(this)) - balBefore; // measured, hook-net
        if (totalTokensBought == 0) revert ZeroBought();
        emit Finalized(tok, curve, poolId, pooledEthSpent, totalTokensBought);
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

    function _claim(address user, address to) internal {
        if (!finalized) revert NotFinalized();
        uint256 c = contribution[user];
        if (c == 0) revert NothingToClaim();
        if (claimed[user]) revert AlreadyClaimed();
        claimed[user] = true; // CEI

        uint256 tokenOut = Math.mulDiv(c, totalTokensBought, totalRaised);
        uint256 ethBack = Math.mulDiv(c, totalRaised - pooledEthSpent, totalRaised);
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
        if (totalRaised < target) {
            // under target: can only fail once the deadline lapses (deposits may still fill it until then)
            if (block.timestamp <= deadline) revert BeforeDeadline();
            failed = true;
            emit Failed(1);
        } else {
            // [L-13] target met: the escape hatch is anchored to when the raise CLOSED (filledAt), not the arbitrary
            // deadline, so an EARLY-filled raise isn't locked until a far-off deadline+grace. filledAt is guaranteed
            // set here (target is reachable only via deposit(), which stamps it) and is always <= deadline (deposits
            // revert past the deadline). Matches finalize()'s [L-20] upper bound: exactly one of the two is ever live.
            if (block.timestamp > uint256(filledAt) + finalizeGrace) {
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
        tokenOut = Math.mulDiv(c, totalTokensBought, totalRaised);
        ethBack = Math.mulDiv(c, totalRaised - pooledEthSpent, totalRaised);
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
