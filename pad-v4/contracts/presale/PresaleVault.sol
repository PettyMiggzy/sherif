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
/// anyone they share it with) can finalize, so the freshly-launched pool is un-addressable and un-front-runnable
/// until the finalize tx; a FINALIZE_GRACE escape hatch converts to Failed (full refunds) if finalize is never
/// called, so ETH can never be permanently trapped. Nothing in the audited curve/hook/factory is modified.
contract PresaleVault is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    uint256 public constant MIN_TARGET = 0.01 ether;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    uint64 public constant GRACE_MIN = 1 hours;
    uint64 public constant GRACE_MAX = 7 days;

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

    // ── mutable state ──
    bool public initialized;
    bool public finalized;
    bool public failed;
    bool private _expectingUnlock; // gates unlockCallback to a finalize the vault itself initiated

    uint256 public totalRaised;
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
    event Failed(uint8 reason); // 1 = under target at deadline, 2 = grace escape hatch
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
                || deadline_ < block.timestamp + MIN_DURATION || deadline_ > block.timestamp + MAX_DURATION
                || finalizeGrace_ < GRACE_MIN || finalizeGrace_ > GRACE_MAX
        ) revert BadParams();
        initialized = true;
        curvePadFactory = ICurvePadFactoryV4(curvePadFactory_);
        poolManager = IPoolManager(curvePadFactory.poolManager());
        cfg = cfg_;
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
        if (finalized || failed) revert NotOpen();
        if (totalRaised < target) revert TargetNotMet();
        if (keccak256(abi.encode(tokenSalt, hookSalt, curveSalt)) != saltCommitment) revert BadReveal();
        finalized = true;

        // launch: deploys token+hook+curve, inits the pool at startTick, seeds the single-sided curve. Takes NO ETH
        // seed and pays the creator NO remainder (no-mint) — the creator profits only via the sell-tax stream +
        // graduation share, never presale ETH.
        LaunchConfig memory c = cfg;
        (address tok, address hook, address curve, PoolId poolId) =
            curvePadFactory.launch(c, tokenSalt, hookSalt, curveSalt);
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
        int24 gradTick = int24(d.startTickMag) - d.curveWidth;
        uint160 gradSqrt = TickMath.getSqrtPriceAtTick(gradTick);

        // pooled buy, atomic with the launch
        uint256 balBefore = IERC20(tok).balanceOf(address(this));
        _expectingUnlock = true;
        poolManager.unlock(abi.encode(totalRaised, key, gradSqrt));
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
    /// past deadline+grace still not finalized (escape hatch — even if target was met but finalize was withheld or
    /// bricked). Permissionless.
    function fail() external nonReentrant {
        if (finalized || failed) revert NotOpen();
        if (block.timestamp <= deadline) revert BeforeDeadline();
        if (totalRaised < target) {
            failed = true;
            emit Failed(1);
        } else if (block.timestamp > uint256(deadline) + finalizeGrace) {
            failed = true;
            emit Failed(2);
        } else {
            revert TargetMet(); // target met, within grace → must finalize, not fail
        }
    }

    /// @notice Reclaim 100% of your contribution after the presale failed. One-shot.
    function refund() external nonReentrant {
        if (!failed) revert NotFailed();
        uint256 c = contribution[msg.sender];
        if (c == 0) revert NothingToClaim();
        if (claimed[msg.sender]) revert AlreadyClaimed();
        claimed[msg.sender] = true; // CEI (shared with claim → a user extracts value at most once)
        (bool ok,) = payable(msg.sender).call{value: c}("");
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
