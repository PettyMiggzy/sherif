// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IStakingFund {
    function fundTokenPushed(uint8 side, address asset) external returns (uint256);
}

/// @title RobinLockStaking — monthly-lock, drip-rewarded, self-filling holder staking for a pad coin
/// @notice Stake the pad coin; it LOCKS for one epoch (default 30 days). While locked you EARN more of the coin,
/// proportional to your share of the pool AND to time — but NOT 1:1: rewards stream out of a finite reservoir at a
/// bounded `rewardRate` (Synthetix drip), so a whale can never drain the pool in one block and the reservoir lasts.
///
/// The reservoir is SELF-FILLING. It is fed by (a) the pad's graduation leftover tokens + sell-side LP fees pushed
/// in by the curve (`fundTokenPushed`), (b) anyone who `fund()`s it, and crucially (c) the 10% EARLY-EXIT PENALTY:
/// withdraw before your lock matures and 10% of the principal you pull is recycled straight back into the reservoir
/// for everyone still staked. So impatience literally pays the diamond hands.
///
/// Accounting invariant (single-token: stake==reward==the pad coin):
///     token.balanceOf(this) == totalStaked + rewardsBalance
/// `totalStaked` is stakers' principal (only they can withdraw it); `rewardsBalance` is every reward token the
/// contract holds (undripped reservoir + dripped-but-unclaimed). Principal is never paid out as reward and reward is
/// never paid out as principal. Rewards notified while nobody is staked are PARKED (never wasted) and begin dripping
/// the moment the first staker arrives.
contract RobinLockStaking is ReentrancyGuard, IStakingFund {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant EARLY_EXIT_PENALTY_BPS = 1000; // 10% of the withdrawn principal → back into the reservoir
    uint256 public constant MIN_LOCK = 7 days;
    uint256 public constant MAX_LOCK = 90 days;

    IERC20 public immutable token; // the pad coin: both the staked asset AND the reward
    uint256 public immutable lockDuration; // per-stake lock (default 30 days)
    uint256 public immutable rewardsDuration; // drip window over which a reward tranche streams (default 30 days)

    // ── drip accounting (Synthetix StakingRewards) ──
    uint256 public periodFinish; // when the current drip ends
    uint256 public rewardRate; // reward tokens per second currently dripping
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public pendingRewards; // reward tokens parked while totalStaked == 0 (start dripping on first stake)

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards; // accrued, claimable reward tokens

    // ── stake accounting ──
    uint256 public totalStaked; // sum of all stakers' principal
    uint256 public rewardsBalance; // reward tokens held (reservoir + owed); keeps the invariant honest
    mapping(address => uint256) public balanceOf; // staked principal
    mapping(address => uint256) public lockedUntil; // full position unlocks at this time (reset on each stake)

    event Staked(address indexed user, uint256 amount, uint256 lockedUntil);
    event Withdrawn(address indexed user, uint256 amount, uint256 penalty);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(address indexed from, uint256 amount, bool dripping);
    event PenaltyRecycled(address indexed user, uint256 amount);

    error ZeroAmount();
    error InsufficientStake();
    error ZeroToken();
    error BadDuration();

    constructor(address token_, uint256 lockDuration_, uint256 rewardsDuration_) {
        if (token_ == address(0)) revert ZeroToken();
        if (lockDuration_ < MIN_LOCK || lockDuration_ > MAX_LOCK) revert BadDuration();
        if (rewardsDuration_ < MIN_LOCK || rewardsDuration_ > MAX_LOCK) revert BadDuration();
        token = IERC20(token_);
        lockDuration = lockDuration_;
        rewardsDuration = rewardsDuration_;
    }

    // ── reward math ──────────────────────────────────────────────────────────────

    function _lastTimeRewardApplicable() internal view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((_lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / totalStaked;
    }

    /// @notice Reward tokens `account` can claim right now.
    function earned(address account) public view returns (uint256) {
        return (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function _updateReward(address account) internal {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = _lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    // ── staking ──────────────────────────────────────────────────────────────────

    /// @notice Stake `amount` of the pad coin. Locks (or re-locks) your WHOLE position for `lockDuration`. While
    /// locked you accrue rewards; you can claim rewards any time, but withdrawing principal early costs 10%.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        totalStaked += amount;
        balanceOf[msg.sender] += amount;
        lockedUntil[msg.sender] = block.timestamp + lockDuration; // adding resets the lock on the full position
        token.safeTransferFrom(msg.sender, address(this), amount);
        // first staker(s): flush any rewards that were parked while the pool was empty, and start the drip now
        if (pendingRewards > 0) {
            uint256 p = pendingRewards;
            pendingRewards = 0;
            _startDrip(p);
        }
        emit Staked(msg.sender, amount, lockedUntil[msg.sender]);
    }

    /// @notice Withdraw `amount` of principal. If your lock hasn't matured, 10% is kept and recycled into the
    /// reward reservoir (self-filling); you receive the other 90%. After maturity there is no penalty.
    function withdraw(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientStake();
        _updateReward(msg.sender);
        balanceOf[msg.sender] -= amount;
        totalStaked -= amount;

        // [audit] if this empties the pool, PAUSE the live drip: bank the still-undripped remaining schedule into
        // pendingRewards and stop the clock. Otherwise the reward-per-token accumulator freezes while totalStaked==0
        // but lastUpdateTime keeps advancing, so the rewards scheduled for the empty window would be stranded forever
        // (the classic Synthetix empty-pool leak). Banking + pausing means the NEXT stake restarts the drip from
        // pendingRewards with nothing lost — upholding the "rewards are never wasted" reservoir invariant.
        if (totalStaked == 0 && rewardRate > 0 && periodFinish > block.timestamp) {
            pendingRewards += (periodFinish - block.timestamp) * rewardRate;
            rewardRate = 0;
            periodFinish = block.timestamp;
        }

        uint256 penalty = 0;
        if (block.timestamp < lockedUntil[msg.sender]) {
            penalty = (amount * EARLY_EXIT_PENALTY_BPS) / BPS;
        }
        uint256 payout = amount - penalty;
        if (penalty > 0) {
            // recycle the penalty into the reservoir: it stays in the contract, moves from principal → reward,
            // and starts dripping to everyone still staked (or parks if the pool just emptied).
            rewardsBalance += penalty;
            _accrueReward(penalty);
            emit PenaltyRecycled(msg.sender, penalty);
        }
        token.safeTransfer(msg.sender, payout);
        emit Withdrawn(msg.sender, amount, penalty);
    }

    /// @notice Claim all accrued reward tokens without touching principal.
    function getReward() public nonReentrant {
        _updateReward(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward == 0) return;
        rewards[msg.sender] = 0;
        rewardsBalance -= reward; // reward leaves the contract; invariant preserved
        token.safeTransfer(msg.sender, reward);
        emit RewardPaid(msg.sender, reward);
    }

    /// @notice Withdraw the entire position AND claim rewards in one call (subject to the early-exit penalty).
    function exit() external {
        withdraw(balanceOf[msg.sender]);
        getReward();
    }

    // ── funding the reservoir ──────────────────────────────────────────────────────

    /// @notice Add `amount` reward tokens to the reservoir (transferFrom the caller). Permissionless — anyone can
    /// top up holder rewards. Starts/extends the drip (or parks if nobody is staked yet).
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(address(0));
        token.safeTransferFrom(msg.sender, address(this), amount);
        rewardsBalance += amount;
        _accrueReward(amount);
    }

    /// @notice Credit reward tokens that were PUSHED to this contract (transferred in, then poked) — the curve uses
    /// this at graduation and for the sell-side LP-fee stream. Any token balance above the accounted total
    /// (totalStaked + rewardsBalance) is treated as a new reward tranche. Permissionless and idempotent: a push of
    /// nothing simply returns 0. `side`/`asset` are ignored (single-token pool) — kept for curve interface parity.
    function fundTokenPushed(uint8, address) external nonReentrant returns (uint256 pushed) {
        uint256 bal = token.balanceOf(address(this));
        uint256 accounted = totalStaked + rewardsBalance;
        if (bal <= accounted) return 0;
        pushed = bal - accounted;
        _updateReward(address(0));
        rewardsBalance += pushed;
        _accrueReward(pushed);
    }

    // ── drip scheduling ────────────────────────────────────────────────────────────

    /// @dev Route a new reward tranche: if nobody is staked, PARK it (never wasted); else (re)start the drip.
    function _accrueReward(uint256 amount) internal {
        if (totalStaked == 0) {
            pendingRewards += amount; // hold until a staker arrives, then _startDrip picks it up
            emit RewardAdded(msg.sender, amount, false);
            return;
        }
        _startDrip(amount + pendingRewards);
        pendingRewards = 0;
        emit RewardAdded(msg.sender, amount, true);
    }

    /// @dev Set rewardRate so `amount` (plus any not-yet-dripped leftover) streams over `rewardsDuration`. Bounds
    /// the payout rate → the reservoir can never be drained instantly. Assumes _updateReward(0) already ran.
    function _startDrip(uint256 amount) internal {
        if (block.timestamp >= periodFinish) {
            rewardRate = amount / rewardsDuration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (amount + leftover) / rewardsDuration;
        }
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
    }

    // ── views for the pad UI / profile ───────────────────────────────────────────────

    /// @notice Seconds until `account`'s locked principal can be withdrawn penalty-free (0 if already unlocked).
    function timeUntilUnlock(address account) public view returns (uint256) {
        uint256 u = lockedUntil[account];
        return block.timestamp >= u ? 0 : u - block.timestamp;
    }

    function isLocked(address account) external view returns (bool) {
        return block.timestamp < lockedUntil[account] && balanceOf[account] > 0;
    }

    /// @notice Total reward tokens that will stream over the remaining/next window (dripping + parked).
    function rewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration + pendingRewards;
    }

    /// @notice Undripped reservoir (parked + not-yet-streamed). Approximate: parked + remaining scheduled drip.
    function reservoir() external view returns (uint256) {
        uint256 remaining = block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate : 0;
        return pendingRewards + remaining;
    }

    /// @notice Rough annualized reward rate in bps of the staked pool (0 if nothing staked). UI estimate only.
    function aprBps() external view returns (uint256) {
        if (totalStaked == 0 || block.timestamp >= periodFinish) return 0;
        return (rewardRate * 365 days * BPS) / totalStaked;
    }

    /// @notice One-call snapshot for a user's profile card.
    function stakeInfo(address account)
        external
        view
        returns (uint256 staked, uint256 claimable, uint256 unlockAt, bool locked)
    {
        staked = balanceOf[account];
        claimable = earned(account);
        unlockAt = lockedUntil[account];
        locked = block.timestamp < unlockAt && staked > 0;
    }

    /// @notice One-call snapshot for the pool header (pool amount, staked, drip).
    function poolInfo()
        external
        view
        returns (uint256 staked, uint256 rewardsHeld, uint256 ratePerSec, uint256 finishAt, uint256 parked)
    {
        return (totalStaked, rewardsBalance, rewardRate, periodFinish, pendingRewards);
    }
}
