// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";
import {RobinStaking} from "./RobinStaking.sol";

interface ICurveForAuction {
    function pool() external view returns (address);
    function gradTick() external view returns (int24);
}

/// @title DailyAuctionVault — optional 0-4 day pre-launch batch auction for a v3 pad coin
/// @notice One instance per launch, created ONLY when the creator opts in (`auctionDays` 1..4). See
/// V3-AUCTION-SPEC.md for the full design discussion; this is the implementation.
///
/// A fixed slice of the coin's curve allocation (`auctionDays * 10%` of what WOULD have gone to the curve,
/// carved out BEFORE the curve is seeded — CurvePadFactory does that arithmetic, this contract just holds
/// and distributes the result) is split evenly across `auctionDays` daily windows. Each day is a sealed
/// BATCH auction, not a continuous-clearing one: bidders send ETH any time during that 24h window, and
/// nobody's allocation or price is decided until the window closes — `dayTranche` tokens (a FIXED supply)
/// are then split pro-rata by bid size among that day's bidders. This is deliberately simpler than Uniswap's
/// Continuous Clearing Auction (which spreads one bid across future intervals and ratchets a floor price):
/// one day, one pot, one split, easy to reason about and to audit.
///
/// The underlying CurvePool is seeded and tradeable from launch, same as always — the auction runs
/// ALONGSIDE it, not as a gate in front of it, so there is never a multi-day dead window with zero
/// DexScreener activity.
///
/// A day's ETH (after the platform's flat 10%) is spent as a real buy-and-burn against the SAME curve the
/// auction is for: genuinely advances curve price and counts toward the ~4.2 ETH graduation raise, exactly
/// like an ordinary buy would. The bought tokens are burned (DEAD), not handed to anyone — bidders already
/// received their allocation from the separately-carved auction supply, so crediting the swap's output too
/// would double-allocate. A day with ZERO bids instead sends that day's whole tranche to a dedicated
/// RobinStaking pool this vault deploys and owns (stake the coin, earn the coin) — unsold auction supply
/// becomes yield instead of overhang, rather than being silently stranded.
contract DailyAuctionVault is IUniswapV3SwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant PLATFORM_BPS = 1000; // flat 10% of a closed day's ETH, off the top
    uint32 public constant DAY = 1 days;
    uint32 public constant STAKING_STREAM = 30 days; // window an unbid day's tranche streams over
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token;
    address public immutable WETH;
    address public immutable curve; // the coin's CurvePool
    address public immutable pool; // curve's underlying Uniswap v3 pool (cached at construction)
    address public immutable platform;
    RobinStaking public immutable stakingPool; // owned by this vault; funded only on a zero-bid day
    uint8 public immutable auctionDays; // 1..4
    uint64 public immutable startTime; // this contract's construction time; day windows are relative to it
    uint256 public immutable dayTranche; // tokens up for grabs each day = auctionAmt / auctionDays

    bool private _swapping;

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
    error NotPool();
    error NoSwap();
    error Zero();

    /// @param auctionAmt_ the total token allocation this vault distributes, across every day combined.
    /// Must divide evenly by `auctionDays_` (CurvePadFactory sizes it that way — an exact multiple, never dust).
    constructor(address token_, address weth_, address curve_, address platform_, uint8 auctionDays_, uint256 auctionAmt_) {
        if (token_ == address(0) || weth_ == address(0) || curve_ == address(0) || platform_ == address(0)) revert Zero();
        require(auctionDays_ > 0 && auctionDays_ <= 4, "days");
        require(auctionAmt_ > 0 && auctionAmt_ % auctionDays_ == 0, "tranche");
        token = IERC20(token_);
        WETH = weth_;
        curve = curve_;
        platform = platform_;
        auctionDays = auctionDays_;
        dayTranche = auctionAmt_ / auctionDays_;
        startTime = uint64(block.timestamp);
        pool = ICurveForAuction(curve_).pool();

        // A dedicated pool this vault owns outright — no cross-factory registry, no separate authorization
        // step. `address(this)` is valid inside a constructor, so the vault can be its own pool's owner AND
        // (per RobinStaking's constructor) its first rewarder in the same breath. Listing the coin itself as
        // a reward asset (alongside the ETH default) is what makes "stake the coin, earn the coin" possible —
        // nothing else in this codebase auto-lists a coin as its own staking pool's reward, which is
        // deliberate everywhere else (it would usually be nonsensical); here it is exactly the point, since
        // the only thing ever funding it is unsold AUCTION supply, never platform or creator revenue.
        RobinStaking sp = new RobinStaking(token_, address(this));
        sp.listReward(token_, STAKING_STREAM);
        stakingPool = sp;
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
            token.forceApprove(address(stakingPool), dayTranche);
            stakingPool.notifyReward(address(token), dayTranche);
            emit DayClosed(day, 0, 0, 0, 0, dayTranche);
            return;
        }

        uint256 toPlatform = (total * PLATFORM_BPS) / 10_000;
        uint256 toCurve = total - toPlatform;
        (bool ok,) = platform.call{value: toPlatform}("");
        require(ok, "platform");

        uint256 burned = _burnBuy(toCurve);
        emit DayClosed(day, total, toPlatform, toCurve, burned, 0);
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

    /// @dev Real buy-and-burn against the curve's live Uniswap v3 position, capped at the SAME graduation
    /// ceiling every other buy respects (`gradTick`) so this can never push price past it. Output is burned.
    function _burnBuy(uint256 value) internal returns (uint256 bought) {
        bool tokenIsToken0 = address(token) < WETH;
        bool zeroForOne = !tokenIsToken0;
        uint160 sqrtLimit = PoolMath.getSqrtRatioAtTick(ICurveForAuction(curve).gradTick());

        IWETH9(WETH).deposit{value: value}();
        _swapping = true;
        IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(value), sqrtLimit, "");
        _swapping = false;

        bought = token.balanceOf(address(this));
        if (bought > 0) token.safeTransfer(DEAD, bought);
        // Refund any unspent WETH (e.g. this day's slice alone hit the ceiling) to the platform, same as the
        // factory's own creation-fee seed buy — never lost, never credited to a bidder who didn't earn it.
        uint256 leftWeth = IERC20(WETH).balanceOf(address(this));
        if (leftWeth > 0) {
            IWETH9(WETH).withdraw(leftWeth);
            (bool ok,) = platform.call{value: leftWeth}("");
            require(ok, "refund");
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (msg.sender != pool) revert NotPool();
        if (!_swapping) revert NoSwap();
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(WETH).safeTransfer(msg.sender, owed);
    }
}
