// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

interface IBoostOracle {
    /// @return boostBps multiplier in basis points (10000 = 1x). Clamped by the caller.
    function boostBps(uint8 side, address user) external view returns (uint256);
}

interface IHookWeightSink {
    function onWeightChange(PoolId id, address user, uint256 newWeight) external;
}

/// @title DualStaking — two-book "earn the other" streaming staking
/// @notice One immutable contract, two independent books:
///   • Side.TOKEN — stake the launched pad token
///   • Side.STOCK — stake the paired stock
/// Each side streams a basket of reward assets (ETH, the OTHER asset, extra tokens). "Earn the
/// other" is not hardcoded — it is simply which assets each side lists (TOKEN side lists the stock
/// as a reward, STOCK side lists the token). The per-(side,asset) accounting is the audited
/// Synthetix `rewardPerToken` streaming engine ported verbatim from RobinStaking (forfeit-to-stayers,
/// empty-pool pause, measured-delta crediting, single-asset claim isolation), with the SheriffStaking
/// anti-JIT hold-delay added and an optional bounded boost applied to weight.
///
/// Anti-JIT is defended twice: rewards STREAM over a window (a flash-staker accrues ≈0), and an
/// `antiJitDelay` hold gates unstake. Principal only ever moves the STAKE asset, so a paused/blocked
/// reward leg never blocks unstake. (Side.STOCK principal is the stock itself, so a stock pause does
/// freeze that principal — inherent and disclosed.)
///
/// When wired to a RobinFeeHook (`hook`/`poolId` set, one side chosen via `weightedSide`), this
/// contract reports that side's boosted weight to the hook so the hook's 3-way holder cut streams to
/// those stakers. The other reward flows are funded directly here.
contract DualStaking is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum Side {
        TOKEN,
        STOCK
    }

    address public constant ETH = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);
    uint256 private constant ACC = 1e30;
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_BOOST_BPS = 40_000; // 4x hard ceiling
    uint256 public constant MAX_REWARD_TOKENS = 8;
    uint32 public constant MIN_DURATION = 1 hours;
    uint32 public constant MAX_DURATION = 365 days;
    uint32 public constant MAX_ANTI_JIT = 7 days;

    IERC20 public immutable tokenAsset; // Side.TOKEN stake asset (the launched token)
    IERC20 public immutable stockAsset; // Side.STOCK stake asset (the paired stock; may be pausable)

    // hook wiring (optional). If set, `weightedSide`'s weight is reported to the hook's holder bucket.
    IHookWeightSink public immutable hook;
    PoolId public immutable poolId;
    uint8 public immutable weightedSide;
    bool public immutable hookWired;

    uint32 public antiJitDelay; // hold after (re)stake before unstake; 0 = no lock; <= MAX_ANTI_JIT
    IBoostOracle public boostOracle; // optional; try/catch, clamped; never blocks staking

    struct RewardInfo {
        bool listed;
        uint32 duration;
        uint64 periodFinish;
        uint64 lastUpdateTime;
        uint256 rewardRate;
        uint256 rewardPerTokenStored;
        uint256 pending;
    }

    // per side [0=TOKEN,1=STOCK]
    mapping(uint8 => uint256) public totalStaked; // raw principal
    mapping(uint8 => uint256) public totalWeight; // boosted
    mapping(uint8 => mapping(address => uint256)) public staked;
    mapping(uint8 => mapping(address => uint256)) public weight;
    mapping(uint8 => mapping(address => uint64)) public stakedAt;

    mapping(uint8 => address[]) internal _rewardTokens;
    mapping(uint8 => mapping(address => RewardInfo)) public rewardInfo;
    mapping(uint8 => mapping(address => mapping(address => uint256))) public userRewardPerTokenPaid;
    mapping(uint8 => mapping(address => mapping(address => uint256))) public rewardsAccrued;

    mapping(address => bool) public isRewarder;
    // contract's accounted balance of each ERC-20 reward asset (for measured-delta on the pushed path)
    mapping(address => uint256) public accountedReserve;

    error Zero();
    error Insufficient();
    error NotListed();
    error AlreadyListed();
    error TooManyRewards();
    error BadDuration();
    error NotRewarder();
    error BadAsset();
    error BadSide();
    error Locked();
    error PayFail();
    error BadParam();

    event Staked(uint8 indexed side, address indexed user, uint256 amount, uint256 newWeight);
    event Unstaked(uint8 indexed side, address indexed user, uint256 amount);
    event Forfeited(uint8 indexed side, address indexed user, address indexed asset, uint256 amount);
    event Claimed(uint8 indexed side, address indexed user, address indexed asset, uint256 amount);
    event RewardAdded(uint8 indexed side, address indexed asset, uint256 amount, bool streamingNow);
    event RewardTokenListed(uint8 indexed side, address indexed asset, uint32 duration);
    event RewarderSet(address indexed who, bool allowed);
    event BoostOracleSet(address indexed oracle);
    event AntiJitDelaySet(uint32 delay);
    event Reweighed(uint8 indexed side, address indexed user, uint256 newWeight);

    constructor(
        address tokenAsset_,
        address stockAsset_,
        address owner_,
        uint32 antiJitDelay_,
        address hook_,
        PoolId poolId_,
        uint8 weightedSide_
    ) Ownable(owner_) {
        if (tokenAsset_ == address(0) || stockAsset_ == address(0)) revert Zero();
        if (antiJitDelay_ > MAX_ANTI_JIT) revert BadParam();
        if (weightedSide_ > uint8(Side.STOCK)) revert BadSide();
        tokenAsset = IERC20(tokenAsset_);
        stockAsset = IERC20(stockAsset_);
        antiJitDelay = antiJitDelay_;
        isRewarder[owner_] = true;
        hook = IHookWeightSink(hook_);
        poolId = poolId_;
        weightedSide = weightedSide_;
        hookWired = hook_ != address(0);
        // ETH is a default reward asset on BOTH sides with a 7-day stream.
        _listReward(uint8(Side.TOKEN), ETH, 7 days);
        _listReward(uint8(Side.STOCK), ETH, 7 days);
    }

    // ───────────────────────────────────────────────────────────── views ──

    function rewardTokens(uint8 side) external view returns (address[] memory) {
        return _rewardTokens[side];
    }

    function _lastTimeApplicable(uint8 side, address asset) internal view returns (uint256) {
        uint256 pf = rewardInfo[side][asset].periodFinish;
        return block.timestamp < pf ? block.timestamp : pf;
    }

    function rewardPerToken(uint8 side, address asset) public view returns (uint256) {
        RewardInfo storage r = rewardInfo[side][asset];
        uint256 tw = totalWeight[side];
        if (tw == 0) return r.rewardPerTokenStored;
        uint256 tApp = _lastTimeApplicable(side, asset);
        if (tApp <= r.lastUpdateTime) return r.rewardPerTokenStored;
        uint256 dt = tApp - r.lastUpdateTime;
        return r.rewardPerTokenStored + Math.mulDiv(dt * r.rewardRate, ACC, tw);
    }

    /// @notice Unclaimed reward of `user` in (side, asset) — weighted by boosted weight.
    function earned(uint8 side, address user, address asset) public view returns (uint256) {
        uint256 delta = rewardPerToken(side, asset) - userRewardPerTokenPaid[side][asset][user];
        return rewardsAccrued[side][asset][user] + Math.mulDiv(weight[side][user], delta, ACC);
    }

    /// @notice The boost (bps) a user would get right now, clamped to [1x, 4x]. Never reverts.
    function boostOf(uint8 side, address user) public view returns (uint256) {
        if (address(boostOracle) == address(0)) return BPS;
        try boostOracle.boostBps(side, user) returns (uint256 b) {
            if (b < BPS) return BPS;
            if (b > MAX_BOOST_BPS) return MAX_BOOST_BPS;
            return b;
        } catch {
            return BPS;
        }
    }

    // ───────────────────────────────────────────── internal accounting ──

    function _updateReward(uint8 side, address account) internal {
        bool empty = totalWeight[side] == 0;
        address[] storage toks = _rewardTokens[side];
        uint256 len = toks.length;
        for (uint256 i; i < len; ++i) {
            address asset = toks[i];
            RewardInfo storage r = rewardInfo[side][asset];
            if (empty) {
                if (r.rewardRate > 0 && r.periodFinish > r.lastUpdateTime) {
                    r.pending += (r.periodFinish - r.lastUpdateTime) * r.rewardRate;
                    r.rewardRate = 0;
                    r.periodFinish = uint64(block.timestamp);
                }
                r.lastUpdateTime = uint64(block.timestamp);
            } else {
                r.rewardPerTokenStored = rewardPerToken(side, asset);
                r.lastUpdateTime = uint64(_lastTimeApplicable(side, asset));
            }
            if (account != address(0)) {
                rewardsAccrued[side][asset][account] = earned(side, account, asset);
                userRewardPerTokenPaid[side][asset][account] = r.rewardPerTokenStored;
            }
        }
    }

    function _kickstartPending(uint8 side) internal {
        address[] storage toks = _rewardTokens[side];
        uint256 len = toks.length;
        for (uint256 i; i < len; ++i) {
            address asset = toks[i];
            RewardInfo storage r = rewardInfo[side][asset];
            if (r.pending > 0) {
                uint256 amt = r.pending;
                r.pending = 0;
                _applyReward(side, asset, amt, true);
                emit RewardAdded(side, asset, amt, true);
            }
        }
    }

    function _applyReward(uint8 side, address asset, uint256 amount, bool extend) internal {
        RewardInfo storage r = rewardInfo[side][asset];
        if (totalWeight[side] == 0) {
            r.pending += amount;
            return;
        }
        if (extend || block.timestamp >= r.periodFinish) {
            uint256 dur = r.duration;
            uint256 leftover = block.timestamp < r.periodFinish ? (r.periodFinish - block.timestamp) * r.rewardRate : 0;
            r.rewardRate = (amount + leftover) / dur;
            r.periodFinish = uint64(block.timestamp + dur);
        } else {
            uint256 remaining = r.periodFinish - block.timestamp;
            r.rewardRate = ((remaining * r.rewardRate) + amount) / remaining;
        }
        r.lastUpdateTime = uint64(block.timestamp);
    }

    /// @dev Recompute the user's boosted weight from current principal + boost, update totalWeight,
    /// and (if wired and this is the weighted side) report the new weight to the hook's holder bucket.
    /// MUST be called after `_updateReward(side, user)` has settled at the OLD weight.
    function _reweigh(uint8 side, address user) internal {
        uint256 old = weight[side][user];
        uint256 nw = Math.mulDiv(staked[side][user], boostOf(side, user), BPS);
        if (nw != old) {
            weight[side][user] = nw;
            totalWeight[side] = totalWeight[side] - old + nw;
            emit Reweighed(side, user, nw);
        }
        if (hookWired && side == weightedSide) hook.onWeightChange(poolId, user, nw);
    }

    // ─────────────────────────────────────────────────────── user actions ──

    function stake(uint8 side, uint256 amount) external nonReentrant {
        _requireSide(side);
        if (amount == 0) revert Zero();
        _updateReward(side, msg.sender);
        IERC20 asset = _stakeAsset(side);
        uint256 balBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = asset.balanceOf(address(this)) - balBefore;
        if (received == 0) revert Zero();
        staked[side][msg.sender] += received;
        totalStaked[side] += received;
        stakedAt[side][msg.sender] = uint64(block.timestamp);
        _reweigh(side, msg.sender);
        _kickstartPending(side);
        emit Staked(side, msg.sender, received, weight[side][msg.sender]);
    }

    function unstake(uint8 side, uint256 amount) external nonReentrant {
        _requireSide(side);
        uint256 bal = staked[side][msg.sender];
        if (amount == 0) revert Zero();
        if (bal < amount) revert Insufficient();
        if (block.timestamp < stakedAt[side][msg.sender] + antiJitDelay) revert Locked();

        _updateReward(side, msg.sender);
        staked[side][msg.sender] = bal - amount;
        totalStaked[side] -= amount;

        // forfeit ALL unclaimed rewards on this side, re-streamed to stayers (never an instant bump)
        address[] storage toks = _rewardTokens[side];
        uint256 len = toks.length;
        for (uint256 i; i < len; ++i) {
            address asset = toks[i];
            uint256 f = rewardsAccrued[side][asset][msg.sender];
            if (f > 0) {
                rewardsAccrued[side][asset][msg.sender] = 0;
                _applyReward(side, asset, f, false);
                emit Forfeited(side, msg.sender, asset, f);
            }
        }

        _reweigh(side, msg.sender);
        _stakeAsset(side).safeTransfer(msg.sender, amount);
        emit Unstaked(side, msg.sender, amount);
    }

    /// @notice Claim one asset on one side. Single-asset so a paused/blocked reward leg only ever
    /// blocks its own claim, never the others, and never the principal.
    function claim(uint8 side, address asset) public nonReentrant returns (uint256 amount) {
        _requireSide(side);
        _updateReward(side, msg.sender);
        amount = rewardsAccrued[side][asset][msg.sender];
        if (amount == 0) revert Zero();
        rewardsAccrued[side][asset][msg.sender] = 0;
        _payout(asset, msg.sender, amount);
        emit Claimed(side, msg.sender, asset, amount);
    }

    /// @notice Anyone can refresh a user's boost weighting (e.g. after their boost tier changes).
    function sync(uint8 side, address user) external nonReentrant {
        _requireSide(side);
        _updateReward(side, user);
        _reweigh(side, user);
    }

    function _payout(address asset, address to, uint256 amount) internal {
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert PayFail();
        } else {
            accountedReserve[asset] -= amount;
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    // ──────────────────────────────────────────────────────────── funding ──

    /// @notice Fund a side's native-ETH stream (the primary hook path). Accounting-only on the ETH
    /// path → cannot revert the caller's swap.
    function fundETH(uint8 side) external payable nonReentrant {
        _requireSide(side);
        if (!isRewarder[msg.sender]) revert NotRewarder();
        if (msg.value == 0) revert Zero();
        _updateReward(side, address(0));
        _applyReward(side, ETH, msg.value, true);
        emit RewardAdded(side, ETH, msg.value, totalWeight[side] > 0);
    }

    /// @notice Fund a side's ERC-20 stream by PULLING from the caller (converter/creator). Measured delta.
    function fundToken(uint8 side, address asset, uint256 amount) external nonReentrant {
        _requireSide(side);
        if (!isRewarder[msg.sender]) revert NotRewarder();
        if (asset == ETH) revert BadAsset();
        if (!rewardInfo[side][asset].listed) revert NotListed();
        if (amount == 0) revert Zero();
        _updateReward(side, address(0));
        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - balBefore;
        if (received == 0) revert Zero();
        accountedReserve[asset] += received;
        _applyReward(side, asset, received, true);
        emit RewardAdded(side, asset, received, totalWeight[side] > 0);
    }

    /// @notice Fund a side's ERC-20 stream from tokens the hook already `take`d straight into this
    /// contract. Credits `balanceOf - accountedReserve` — the amount that arrived since the last
    /// accounting — so no allowance/transferFrom is needed on the hook's hot path.
    function fundTokenPushed(uint8 side, address asset) external nonReentrant returns (uint256 received) {
        _requireSide(side);
        if (!isRewarder[msg.sender]) revert NotRewarder();
        if (asset == ETH) revert BadAsset();
        if (!rewardInfo[side][asset].listed) revert NotListed();
        uint256 bal = IERC20(asset).balanceOf(address(this));
        received = bal - accountedReserve[asset];
        if (received == 0) revert Zero();
        accountedReserve[asset] = bal;
        _updateReward(side, address(0));
        _applyReward(side, asset, received, true);
        emit RewardAdded(side, asset, received, totalWeight[side] > 0);
    }

    // ───────────────────────────────────────────────────────────── admin ──

    function _listReward(uint8 side, address asset, uint32 duration) internal {
        if (rewardInfo[side][asset].listed) revert AlreadyListed();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        if (_rewardTokens[side].length >= MAX_REWARD_TOKENS) revert TooManyRewards();
        rewardInfo[side][asset].listed = true;
        rewardInfo[side][asset].duration = duration;
        _rewardTokens[side].push(asset);
        emit RewardTokenListed(side, asset, duration);
    }

    function listReward(uint8 side, address asset, uint32 duration) external onlyOwner {
        _requireSide(side);
        if (asset == address(0)) revert BadAsset();
        _listReward(side, asset, duration);
    }

    function setRewarder(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert BadAsset();
        isRewarder[who] = allowed;
        emit RewarderSet(who, allowed);
    }

    function setBoostOracle(address oracle) external onlyOwner {
        boostOracle = IBoostOracle(oracle);
        emit BoostOracleSet(oracle);
    }

    function setAntiJitDelay(uint32 delay) external onlyOwner {
        if (delay > MAX_ANTI_JIT) revert BadParam();
        antiJitDelay = delay;
        emit AntiJitDelaySet(delay);
    }

    // ──────────────────────────────────────────────────────────── helpers ──

    function _requireSide(uint8 side) internal pure {
        if (side > uint8(Side.STOCK)) revert BadSide();
    }

    function _stakeAsset(uint8 side) internal view returns (IERC20) {
        return side == uint8(Side.TOKEN) ? tokenAsset : stockAsset;
    }

    /// @notice Accept ETH from an authorized rewarder as a TOKEN-side ETH reward (e.g. a vault flush).
    receive() external payable nonReentrant {
        if (!isRewarder[msg.sender]) revert NotRewarder();
        if (msg.value == 0) return;
        _updateReward(uint8(Side.TOKEN), address(0));
        _applyReward(uint8(Side.TOKEN), ETH, msg.value, true);
        emit RewardAdded(uint8(Side.TOKEN), ETH, msg.value, totalWeight[uint8(Side.TOKEN)] > 0);
    }
}
