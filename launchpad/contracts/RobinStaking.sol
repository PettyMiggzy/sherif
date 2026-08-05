// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RobinStaking — no-lock, forfeit-to-stayers, multi-asset streaming staking
/// @notice Stake one token (e.g. $ROBIN, or a launched coin) and earn a basket of reward assets — native
/// ETH and/or any ERC-20 (the Robinhood Stock Tokens: AAPL, NVDA, SGOV…). Two design rules the user asked for:
///
///   1. NO LOCK. Principal is withdrawable at any instant. `unstake` can NEVER be blocked — not by a time
///      lock (there is none) and not by a paused/blocked reward token (unstake never *transfers* a reward
///      token, it only does internal math). Your staked capital is always yours to pull.
///
///   2. LEAVE EARLY → FORFEIT PENDING. Unstaking (any amount) forfeits ALL of your unclaimed rewards, across
///      every reward asset, and those forfeited rewards are redistributed **to the stakers who stayed**
///      (divided over everyone *except* the leaver). Paper hands literally fund diamond hands.
///
/// JIT (just-in-time) reward-capture — stake right before a reward drop, grab a slice, leave — is defeated
/// WITHOUT a lock by STREAMING every reward linearly over a window (`duration`, e.g. 7 days) rather than
/// dropping it as an instant lump. A flash-staker accrues only the sliver that streams during their brief
/// stay (≈0), and forfeits even that on exit. A real staker just stays and the stream accrues to them; they
/// can `claim()` at any time while staked (claiming is NOT unstaking, so it never forfeits).
///
/// Accounting is the Synthetix `rewardPerToken` accumulator, one per reward asset — O(#rewardAssets) per user
/// action, no unbounded loops (reward assets are capped at MAX_REWARD_TOKENS). Rewards that arrive while
/// nobody is staked are parked in `pending` and kick the stream off on the next stake, so nothing is lost.
contract RobinStaking is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @dev Sentinel address that represents native ETH as a reward asset (vs. an ERC-20 reward token).
    address public constant ETH = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);
    /// @dev High-precision fixed-point scaler for the per-share accumulators (reward tokens are 18-dp).
    uint256 private constant ACC = 1e30;
    /// @dev Hard cap on distinct reward assets, so per-action loops are always bounded (gas-safe).
    uint256 public constant MAX_REWARD_TOKENS = 8;
    /// @dev Bounds on a reward stream's duration.
    uint32 public constant MIN_DURATION = 1 hours;
    uint32 public constant MAX_DURATION = 365 days;

    IERC20 public immutable stakeToken; // the token users stake (e.g. $ROBIN)

    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    struct RewardInfo {
        bool listed; // reward asset is registered
        uint32 duration; // streaming window in seconds
        uint64 periodFinish; // timestamp the current stream ends
        uint64 lastUpdateTime; // last time the accumulator was advanced
        uint256 rewardRate; // reward-token units streamed per second
        uint256 rewardPerTokenStored; // Σ rewardRate·dt·ACC/totalStaked  (+ forfeiture bumps)
        uint256 pending; // reward-token units received while totalStaked == 0, awaiting kickstart
    }

    address[] public rewardTokens; // enumerable set of reward assets
    mapping(address => RewardInfo) public rewardInfo; // asset => stream state
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid; // asset => user => rpt checkpoint
    mapping(address => mapping(address => uint256)) public rewardsAccrued; // asset => user => settled-but-unclaimed

    mapping(address => bool) public isRewarder; // addresses allowed to fund rewards (fee router, converter, owner)

    error Zero();
    error Insufficient();
    error NotListed();
    error AlreadyListed();
    error TooManyRewards();
    error BadDuration();
    error NotRewarder();
    error BadAsset();
    error EthMismatch();
    error PayFail();

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount, uint256 stakeReturned);
    event Forfeited(address indexed user, address indexed asset, uint256 amount, uint256 toStayers);
    event Claimed(address indexed user, address indexed asset, uint256 amount);
    event RewardAdded(address indexed asset, uint256 amount, bool streamingNow);
    event RewardTokenListed(address indexed asset, uint32 duration);
    event RewardDurationSet(address indexed asset, uint32 duration);
    event RewarderSet(address indexed who, bool allowed);

    constructor(address stakeToken_, address owner_) Ownable(owner_) {
        if (stakeToken_ == address(0)) revert Zero();
        stakeToken = IERC20(stakeToken_);
        isRewarder[owner_] = true;
        // ETH is always available as a reward asset with a default 7-day stream.
        _listReward(ETH, 7 days);
    }

    // ─────────────────────────────────────────────────────────── views ──

    function rewardTokensLength() external view returns (uint256) {
        return rewardTokens.length;
    }

    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokens;
    }

    function _lastTimeApplicable(address asset) internal view returns (uint256) {
        uint256 pf = rewardInfo[asset].periodFinish;
        return block.timestamp < pf ? block.timestamp : pf;
    }

    /// @notice Current per-share accumulator for `asset`, extrapolated to now.
    function rewardPerToken(address asset) public view returns (uint256) {
        RewardInfo storage r = rewardInfo[asset];
        if (totalStaked == 0) return r.rewardPerTokenStored;
        uint256 dt = _lastTimeApplicable(asset) - r.lastUpdateTime;
        if (dt == 0) return r.rewardPerTokenStored;
        return r.rewardPerTokenStored + Math.mulDiv(dt * r.rewardRate, ACC, totalStaked);
    }

    /// @notice Unclaimed reward of `user` in `asset` (what they'd get by claim(), or LOSE by unstaking).
    function earned(address user, address asset) public view returns (uint256) {
        uint256 delta = rewardPerToken(asset) - userRewardPerTokenPaid[asset][user];
        return rewardsAccrued[asset][user] + Math.mulDiv(staked[user], delta, ACC);
    }

    /// @notice Convenience: all pending rewards for `user`, one entry per reward asset (same order as rewardTokens).
    function earnedAll(address user) external view returns (address[] memory assets, uint256[] memory amounts) {
        assets = rewardTokens;
        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            amounts[i] = earned(user, assets[i]);
        }
    }

    // ─────────────────────────────────────────────── internal accounting ──

    /// @dev Advance every reward accumulator to now, and (if `account` != 0) settle that account's earned
    /// balance into `rewardsAccrued`. Math only — never transfers, so this can't be bricked by a paused asset.
    function _updateReward(address account) internal {
        uint256 len = rewardTokens.length;
        for (uint256 i; i < len; ++i) {
            address asset = rewardTokens[i];
            RewardInfo storage r = rewardInfo[asset];
            r.rewardPerTokenStored = rewardPerToken(asset);
            r.lastUpdateTime = uint64(_lastTimeApplicable(asset));
            if (account != address(0)) {
                rewardsAccrued[asset][account] = earned(account, asset);
                userRewardPerTokenPaid[asset][account] = r.rewardPerTokenStored;
            }
        }
    }

    /// @dev Kick off any parked (pending) reward streams once there is stake to stream to. Called right
    /// after totalStaked goes positive.
    function _kickstartPending() internal {
        uint256 len = rewardTokens.length;
        for (uint256 i; i < len; ++i) {
            address asset = rewardTokens[i];
            RewardInfo storage r = rewardInfo[asset];
            if (r.pending > 0) {
                uint256 amt = r.pending;
                r.pending = 0;
                _startStream(asset, amt);
            }
        }
    }

    /// @dev Start or top-up the linear stream for `asset` with `amount` fresh reward units. Standard Synthetix
    /// top-up: any not-yet-streamed remainder of the current window is rolled into the new rate.
    function _startStream(address asset, uint256 amount) internal {
        RewardInfo storage r = rewardInfo[asset];
        uint256 dur = r.duration;
        if (block.timestamp >= r.periodFinish) {
            r.rewardRate = amount / dur;
        } else {
            uint256 leftover = (r.periodFinish - block.timestamp) * r.rewardRate;
            r.rewardRate = (amount + leftover) / dur;
        }
        r.lastUpdateTime = uint64(block.timestamp);
        r.periodFinish = uint64(block.timestamp + dur);
    }

    // ──────────────────────────────────────────────────────── user actions ──

    /// @notice Stake `amount` of the stake token. Settles your rewards first, then starts any parked streams.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert Zero();
        _updateReward(msg.sender);
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        _kickstartPending();
        emit Staked(msg.sender, amount);
    }

    /// @notice Unstake `amount`. NO LOCK — always succeeds. FORFEITS all your unclaimed rewards (every asset),
    /// redistributing them to the stakers who stayed. Claim first (see `claim`) if you want to keep them.
    /// @dev Only ever transfers the STAKE token out; never a reward token — so a paused/blocked reward asset
    /// can never block your exit. Reentrancy-guarded; principal transfer is last.
    function unstake(uint256 amount) external nonReentrant {
        uint256 bal = staked[msg.sender];
        if (amount == 0) revert Zero();
        if (bal < amount) revert Insufficient();

        _updateReward(msg.sender);

        // Everyone except the leaver — the forfeited rewards are divided over this stake.
        uint256 otherStake = totalStaked - bal;

        // Remove the leaver's stake BEFORE redistribution so they cannot earn on their own forfeiture.
        staked[msg.sender] = bal - amount;
        totalStaked -= amount;

        // Forfeit every unclaimed reward asset and hand it to the stayers.
        uint256 len = rewardTokens.length;
        for (uint256 i; i < len; ++i) {
            address asset = rewardTokens[i];
            uint256 f = rewardsAccrued[asset][msg.sender];
            if (f > 0) {
                rewardsAccrued[asset][msg.sender] = 0;
                RewardInfo storage r = rewardInfo[asset];
                uint256 toStayers;
                if (otherStake > 0) {
                    // Instant per-share bump for the stayers (excludes the leaver's remaining stake below).
                    r.rewardPerTokenStored += Math.mulDiv(f, ACC, otherStake);
                    toStayers = f;
                } else {
                    // No one else is staked — park it; it re-streams on the next stake.
                    r.pending += f;
                }
                // Reset the leaver's checkpoint to the POST-bump value so their remaining stake (on a partial
                // unstake) does not recapture any of what they just forfeited.
                userRewardPerTokenPaid[asset][msg.sender] = r.rewardPerTokenStored;
                emit Forfeited(msg.sender, asset, f, toStayers);
            }
        }

        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, amount);
    }

    /// @notice Claim your accrued reward for a single asset (leaving your stake in place — no forfeiture).
    /// Single-asset so a paused/blocked reward token can only ever block ITS OWN claim, never the others.
    function claim(address asset) public nonReentrant returns (uint256 amount) {
        _updateReward(msg.sender);
        amount = rewardsAccrued[asset][msg.sender];
        if (amount == 0) revert Zero();
        rewardsAccrued[asset][msg.sender] = 0;
        _payout(asset, msg.sender, amount);
        emit Claimed(msg.sender, asset, amount);
    }

    /// @notice Claim several assets at once. Reverts if any listed asset's transfer fails; use single-asset
    /// `claim` to route around a temporarily paused reward token.
    function claimMany(address[] calldata assets) external nonReentrant returns (uint256[] memory amounts) {
        _updateReward(msg.sender);
        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = rewardsAccrued[asset][msg.sender];
            if (amount > 0) {
                rewardsAccrued[asset][msg.sender] = 0;
                _payout(asset, msg.sender, amount);
                amounts[i] = amount;
                emit Claimed(msg.sender, asset, amount);
            }
        }
    }

    function _payout(address asset, address to, uint256 amount) internal {
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert PayFail();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    // ────────────────────────────────────────────────────────── funding ──

    /// @notice Fund an ERC-20 reward stream. Pulls `amount` of `asset` from the caller (a rewarder), then
    /// streams it over `asset`'s duration. If nobody is staked yet, it's parked and streams on the next stake.
    function notifyReward(address asset, uint256 amount) external nonReentrant {
        if (!isRewarder[msg.sender]) revert NotRewarder();
        if (asset == ETH) revert BadAsset(); // use notifyRewardETH for native ETH
        if (!rewardInfo[asset].listed) revert NotListed();
        if (amount == 0) revert Zero();
        _updateReward(address(0));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        _fund(asset, amount);
    }

    /// @notice Fund the native-ETH reward stream with the attached value.
    function notifyRewardETH() external payable nonReentrant {
        if (!isRewarder[msg.sender]) revert NotRewarder();
        if (msg.value == 0) revert Zero();
        _updateReward(address(0));
        _fund(ETH, msg.value);
    }

    function _fund(address asset, uint256 amount) internal {
        RewardInfo storage r = rewardInfo[asset];
        if (totalStaked == 0) {
            r.pending += amount; // no stakers yet — park it, kickstarts on next stake
            emit RewardAdded(asset, amount, false);
        } else {
            _startStream(asset, amount);
            emit RewardAdded(asset, amount, true);
        }
    }

    // ─────────────────────────────────────────────────────────── admin ──

    function _listReward(address asset, uint32 duration) internal {
        if (rewardInfo[asset].listed) revert AlreadyListed();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        if (rewardTokens.length >= MAX_REWARD_TOKENS) revert TooManyRewards();
        rewardInfo[asset].listed = true;
        rewardInfo[asset].duration = duration;
        rewardTokens.push(asset);
        emit RewardTokenListed(asset, duration);
    }

    /// @notice Register a new reward asset (an ERC-20 stock token, or ETH) with its streaming window.
    function listReward(address asset, uint32 duration) external onlyOwner {
        if (asset == address(0)) revert BadAsset();
        _listReward(asset, duration);
    }

    /// @notice Change a reward asset's streaming window. Applies to the NEXT funding (the live stream keeps
    /// its current rate until it finishes or is topped up).
    function setRewardDuration(address asset, uint32 duration) external onlyOwner {
        if (!rewardInfo[asset].listed) revert NotListed();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        rewardInfo[asset].duration = duration;
        emit RewardDurationSet(asset, duration);
    }

    /// @notice Authorize / revoke an address that may fund rewards (the fee router, the ETH→stock converter…).
    function setRewarder(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert BadAsset();
        isRewarder[who] = allowed;
        emit RewarderSet(who, allowed);
    }

    /// @notice Accept plain ETH sends from an authorized rewarder as an ETH reward (e.g. an ATH-vault flush).
    receive() external payable {
        if (!isRewarder[msg.sender]) revert NotRewarder();
        _updateReward(address(0));
        _fund(ETH, msg.value);
    }
}
