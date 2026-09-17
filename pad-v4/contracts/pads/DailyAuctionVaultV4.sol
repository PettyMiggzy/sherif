// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";

/// @dev Just the RobinCurveV4 getters this vault needs to reconstruct the pad's PoolKey and graduation
/// ceiling — all public immutables on the real contract, read once at construction.
interface ICurveV4ForAuction {
    function currency0() external view returns (Currency);
    function currency1() external view returns (Currency);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function hooks() external view returns (IHooks);
    function gradTick() external view returns (int24);
}

interface IRobinStakingDeployerV4 {
    function deploy(address stakeToken, address owner) external returns (address);
}

/// @dev Just the RobinStaking calls this vault needs — see RobinStaking.sol's own doc comment and the v3
/// DailyAuctionVault's identical note: importing (and `new`-ing) RobinStaking directly here would inline its
/// creation bytecode into THIS contract's own deployed bytecode, which is exactly what the thin-deployer
/// pattern (AuctionV4Deployers.sol) exists to avoid.
interface IRobinStakingV4 {
    function listReward(address asset, uint32 duration) external;
    function notifyReward(address asset, uint256 amount) external;
}

/// @title DailyAuctionVaultV4 — optional 0-4 day pre-launch batch auction for a v4 pad coin
/// @notice pad-v4 sibling of launchpad's DailyAuctionVault — same design (see that contract's doc comment for
/// the full rationale), ported to Uniswap v4's PoolManager.unlock()/unlockCallback swap pattern instead of a
/// direct pool.swap() call (reusing the exact pattern PresaleVault.sol's pooled buy already established).
///
/// One instance per launch, created ONLY when the creator opts in (`auctionDays` 1..4). CurvePadFactoryV4
/// carves `auctionDays * 10%` of what WOULD have gone to the curve's sellable supply out BEFORE the curve is
/// seeded, splits it evenly across `auctionDays` daily sealed-batch-auction windows, and hands this vault that
/// carve-out to hold and distribute. The underlying RobinCurveV4 is seeded and tradeable from launch, same as
/// always — the auction runs ALONGSIDE it, not as a gate in front of it.
///
/// A day's ETH (after the platform's flat 10%) is spent as a real buy against the SAME curve the auction is
/// for — genuinely advances curve price and counts toward the raise, exactly like an ordinary buy would. Unlike
/// v3 (which reads a post-swap balance and must therefore measure a DELTA to avoid sweeping this vault's own
/// persistent reserve), this swap's output is taken directly to the dead address via `poolManager.take`, using
/// the EXACT amount the swap's own BalanceDelta reports — this vault's token balance is never touched by the
/// burn at all, sidestepping that whole bug class by construction rather than by a balance-delta check. A day
/// with ZERO bids sends that day's whole tranche to a dedicated RobinStaking pool this vault deploys (lazily,
/// on first use) and owns — unsold auction supply becomes yield instead of overhang.
contract DailyAuctionVaultV4 is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant PLATFORM_BPS = 1000; // flat 10% of a closed day's ETH, off the top
    uint32 public constant DAY = 1 days;
    uint32 public constant STAKING_STREAM = 30 days; // window an unbid day's tranche streams over
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token;
    IPoolManager public immutable poolManager;
    address public immutable curve; // the coin's RobinCurveV4 controller
    address public immutable feeRegistry; // resolved live at payout time, same as the curve/hook/PresaleVault
    address public immutable robinStakingDeployer; // thin deployer (see IRobinStakingV4's doc comment)
    address public stakingPool; // deployed LAZILY, on the first zero-bid day — see _stakingPoolOrDeploy
    uint8 public immutable auctionDays; // 1..4
    uint64 public immutable startTime; // this contract's construction time; day windows are relative to it
    uint256 public immutable dayTranche; // tokens up for grabs each day = auctionAmt / auctionDays

    // the pad's PoolKey, reconstructed once at construction from the curve's own public immutables
    Currency internal immutable _currency0;
    Currency internal immutable _currency1;
    uint24 internal immutable _fee;
    int24 internal immutable _tickSpacing;
    IHooks internal immutable _hooks;
    int24 internal immutable _gradTick; // buys (incl. this vault's burn-buy) never push spot past this

    bool private _expectingUnlock;

    mapping(uint8 => uint256) public dayTotal; // day => total ETH bid
    mapping(uint8 => mapping(address => uint256)) public bidOf; // day => bidder => ETH bid
    mapping(uint8 => bool) public closed; // day => closeDay() has run
    mapping(uint8 => mapping(address => bool)) public claimed; // day => bidder => already claimed

    event Bid(uint8 indexed day, address indexed bidder, uint256 amount);
    event DayClosed(
        uint8 indexed day, uint256 totalBid, uint256 toPlatform, uint256 toCurve, uint256 tokensBurned, uint256 tokensToStaking
    );
    event Claimed(uint8 indexed day, address indexed bidder, uint256 tokens);

    error BadDay();
    error WindowClosed();
    error WindowNotOpen();
    error AlreadyClosed();
    error NotClosed();
    error AlreadyClaimed();
    error NothingBid();
    error NotPoolManager();
    error UnexpectedUnlock();
    error EthSendFailed();
    error Zero();

    /// @param auctionAmt_ the total token allocation this vault distributes, across every day combined.
    /// Must divide evenly by `auctionDays_` (CurvePadFactoryV4 sizes it that way — an exact multiple, never dust).
    constructor(
        address token_,
        address poolManager_,
        address curve_,
        address feeRegistry_,
        address robinStakingDeployer_,
        uint8 auctionDays_,
        uint256 auctionAmt_
    ) {
        if (
            token_ == address(0) || poolManager_ == address(0) || curve_ == address(0) || feeRegistry_ == address(0)
                || robinStakingDeployer_ == address(0)
        ) revert Zero();
        require(auctionDays_ > 0 && auctionDays_ <= 4, "days");
        require(auctionAmt_ > 0 && auctionAmt_ % auctionDays_ == 0, "tranche");
        token = IERC20(token_);
        poolManager = IPoolManager(poolManager_);
        curve = curve_;
        feeRegistry = feeRegistry_;
        robinStakingDeployer = robinStakingDeployer_;
        auctionDays = auctionDays_;
        dayTranche = auctionAmt_ / auctionDays_;
        startTime = uint64(block.timestamp);

        ICurveV4ForAuction c = ICurveV4ForAuction(curve_);
        _currency0 = c.currency0();
        _currency1 = c.currency1();
        _fee = c.fee();
        _tickSpacing = c.tickSpacing();
        _hooks = c.hooks();
        _gradTick = c.gradTick();
        // stakingPool is deployed LAZILY (see _stakingPoolOrDeploy), not here — same gas-budget reasoning as
        // v3's DailyAuctionVault: most auction days have bids and never need a staking pool at all, and
        // closeDay() is its own transaction with its own full gas budget, days later.
    }

    /// @notice `day`'s bidding window as [opens, closes) unix timestamps.
    function dayWindow(uint8 day) public view returns (uint64 opens, uint64 closes) {
        opens = startTime + (uint64(day) - 1) * DAY;
        closes = startTime + uint64(day) * DAY;
    }

    /// @notice Bid ETH on `day` (1..auctionDays). Permissionless, additive — bidding again on the same day
    /// adds to your existing bid for it. Must land inside that day's 24h window.
    function bid(uint8 day) external payable nonReentrant {
        if (day == 0 || day > auctionDays) revert BadDay();
        if (msg.value == 0) revert Zero();
        (uint64 opens, uint64 closes) = dayWindow(day);
        if (block.timestamp < opens) revert WindowNotOpen();
        if (block.timestamp >= closes) revert WindowClosed();
        dayTotal[day] += msg.value;
        bidOf[day][msg.sender] += msg.value;
        emit Bid(day, msg.sender, msg.value);
    }

    /// @notice Close `day` once its window has passed. Permissionless, callable by anyone (a keeper, a
    /// bidder, whoever notices first) — nothing about the outcome depends on who calls it.
    function closeDay(uint8 day) external nonReentrant {
        if (day == 0 || day > auctionDays) revert BadDay();
        (, uint64 closes) = dayWindow(day);
        if (block.timestamp < closes) revert WindowNotOpen();
        if (closed[day]) revert AlreadyClosed();
        closed[day] = true;

        uint256 total = dayTotal[day];
        if (total == 0) {
            address sp = _stakingPoolOrDeploy();
            token.forceApprove(sp, dayTranche);
            IRobinStakingV4(sp).notifyReward(address(token), dayTranche);
            emit DayClosed(day, 0, 0, 0, 0, dayTranche);
            return;
        }

        uint256 toPlatform = (total * PLATFORM_BPS) / 10_000;
        uint256 toCurve = total - toPlatform;
        address platform = IFeeWalletRegistry(feeRegistry).platformFeeWallet();
        (bool ok,) = platform.call{value: toPlatform}("");
        if (!ok) revert EthSendFailed();

        uint256 burned = _burnBuy(toCurve);
        emit DayClosed(day, total, toPlatform, toCurve, burned, 0);
    }

    /// @dev Deploy the dedicated RobinStaking pool (via the thin deployer, see IRobinStakingV4's doc comment)
    /// on first use (a zero-bid day), not at construction. Idempotent: later zero-bid days reuse the same pool.
    /// owner == address(this): RobinStaking's constructor auto-authorizes whoever it's told is the owner as its
    /// first rewarder, so this vault can call notifyReward on the pool it just had built, no separate
    /// authorization step needed.
    function _stakingPoolOrDeploy() internal returns (address sp) {
        sp = stakingPool;
        if (sp != address(0)) return sp;
        sp = IRobinStakingDeployerV4(robinStakingDeployer).deploy(address(token), address(this));
        IRobinStakingV4(sp).listReward(address(token), STAKING_STREAM);
        stakingPool = sp;
    }

    /// @notice Claim your share of `day`'s tranche: `yourBid / dayTotal * dayTranche`. Callable any time
    /// after `closeDay(day)` — pull-based, no forced deadline.
    function claim(uint8 day) external nonReentrant returns (uint256 amount) {
        if (!closed[day]) revert NotClosed();
        if (claimed[day][msg.sender]) revert AlreadyClaimed();
        uint256 b = bidOf[day][msg.sender];
        if (b == 0) revert NothingBid();
        claimed[day][msg.sender] = true;
        amount = (dayTranche * b) / dayTotal[day];
        if (amount > 0) token.safeTransfer(msg.sender, amount);
        emit Claimed(day, msg.sender, amount);
    }

    /// @dev Real buy against the curve's live Uniswap v4 position, price-limited at the SAME graduation
    /// ceiling every other buy respects (`gradTick`) so this can never push price past it. Output is burned.
    function _burnBuy(uint256 value) internal returns (uint256 bought) {
        _expectingUnlock = true;
        bytes memory result = poolManager.unlock(abi.encode(value));
        _expectingUnlock = false;
        bought = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_expectingUnlock) revert UnexpectedUnlock();
        uint256 value = abi.decode(data, (uint256));

        PoolKey memory key =
            PoolKey({currency0: _currency0, currency1: _currency1, fee: _fee, tickSpacing: _tickSpacing, hooks: _hooks});
        uint160 gradSqrt = TickMath.getSqrtPriceAtTick(_gradTick);

        BalanceDelta delta = poolManager.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: -int256(value), sqrtPriceLimitX96: gradSqrt}), ""
        );
        uint256 ethOwed = uint256(uint128(-delta.amount0())); // ETH this vault owes the pool (<= value)
        uint256 tokenOut = uint256(uint128(delta.amount1())); // token bought, net of the hook's buy tax
        poolManager.settle{value: ethOwed}();
        // Taken DIRECTLY to the dead address — this vault's own token balance (which holds the persistent,
        // not-yet-claimed reserve for every OTHER day) is never touched by the burn at all. No balance read,
        // so there is nothing here for the v3 balance-delta bug class to happen to.
        if (tokenOut > 0) poolManager.take(_currency1, DEAD, tokenOut);

        // The swap can stop short of `value` at the price limit (this day's slice alone hit the ceiling); any
        // unspent ETH is refunded to the platform, same as the factory's own creation-fee/pooled-buy handling —
        // never lost, never credited to a bidder who didn't earn it.
        uint256 leftover = value - ethOwed;
        if (leftover > 0) {
            address platform = IFeeWalletRegistry(feeRegistry).platformFeeWallet();
            (bool ok,) = platform.call{value: leftover}("");
            if (!ok) revert EthSendFailed();
        }

        return abi.encode(tokenOut);
    }
}
