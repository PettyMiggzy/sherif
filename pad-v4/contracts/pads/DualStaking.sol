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
/// [M-6] INERT IN THE SHIPPED SUITE. `hook`/`poolId`/`weightedSide` and the `IHookWeightSink` callback in
/// `_reweigh` were built for a 3-way fee hook with an O(1) HOLDER BUCKET that was designed but never shipped:
/// `RobinFeeHook` has no `onWeightChange` selector and no holder book, and `StakingFactory.createPool` always
/// passes `hook_ = address(0)`. The wiring is harmless (the notify is try/caught so it can never block
/// principal — see the [audit M2] note in `_reweigh`) but it advertises a reward stream this suite does not
/// deliver. Nothing streams to stakers through the hook; every reward flow is funded directly here. Kept only
/// so an external sink implementing that interface could be wired later — do not read it as a live feature.
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
    /// [M-20] Floor on the window any tranche may be scheduled over. Without it the mid-window branch divides by
    /// `remaining`, so a donation arriving in a window's tail streams over seconds and whoever is staked for those
    /// seconds takes it — measured at 99.00% of a creator's 10 ETH gift by a whale staked 121 seconds.
    ///
    /// [M-13] This constant is also the CONCENTRATION FLOOR, and that is a deliberate trade rather than a free
    /// win. Since M-13 the relay funding paths pass extend=FALSE, so a tranche pushed mid-window is scheduled
    /// over `max(remaining, MIN_DRIP_WINDOW)` instead of a fresh full `duration`. That is what stops a stranger
    /// stalling the stream forever — but it also means the shortest horizon any relay push can be spread over is
    /// one day, where before it was the reward's full duration. A whale that stakes when a relay poke lands
    /// therefore needs ONE DAY of exposure to take the bulk of that tranche, not `duration`. Measured by
    /// test/regression/M13.relay-poke.test.js. The defence against that is `antiJitDelay`, which gates unstake
    /// and which StakingFactory currently defaults to 0 — an operator wiring a pool to a permissionless relay
    /// should set it to at least MIN_DRIP_WINDOW. That default is a product decision and is deliberately not
    /// changed here.
    uint256 public constant MIN_DRIP_WINDOW = 1 days;
    uint16 public constant MAX_CLAIM_FEE_BPS = 1_000; // platform's cut of a claim, capped at 10%

    IERC20 public immutable tokenAsset; // Side.TOKEN stake asset (the launched token)
    IERC20 public immutable stockAsset; // Side.STOCK stake asset (the paired stock; may be pausable)

    // hook wiring (optional). If set, `weightedSide`'s weight is reported to the hook's holder bucket.
    IHookWeightSink public immutable hook;
    PoolId public immutable poolId;
    uint8 public immutable weightedSide;
    bool public immutable hookWired;

    uint32 public antiJitDelay; // hold after (re)stake before unstake; 0 = no lock; <= MAX_ANTI_JIT
    IBoostOracle public boostOracle; // optional; try/catch, clamped; never blocks staking

    // Platform revenue: a cut of every reward CLAIM (no lock, no principal touched). Accrue-and-pull.
    uint16 public platformClaimFeeBps; // default 0; owner-settable up to MAX_CLAIM_FEE_BPS
    address public platformTreasury; // where the claim-fee cut is paid; defaults to owner
    mapping(address => uint256) public platformFeesOwed; // asset => accrued platform cut

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
    error SideDisabled();
    error Locked();
    error PayFail();
    error BadParam();
    error RenounceDisabled();

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
    event WeightSyncFailed(uint8 indexed side, address indexed user, uint256 newWeight);
    event PlatformClaimFeeSet(uint16 bps);
    event PlatformTreasurySet(address indexed treasury);
    event PlatformClaimFeeTaken(address indexed asset, uint256 amount);
    event PlatformFeesClaimed(address indexed asset, address indexed to, uint256 amount);

    constructor(
        address tokenAsset_,
        address stockAsset_,
        address owner_,
        uint32 antiJitDelay_,
        address hook_,
        PoolId poolId_,
        uint8 weightedSide_
    ) Ownable(owner_) {
        // stockAsset may be 0 → single-book pool (any plain coin can stake; the STOCK side is disabled).
        if (tokenAsset_ == address(0)) revert Zero();
        if (antiJitDelay_ > MAX_ANTI_JIT) revert BadParam();
        if (weightedSide_ > uint8(Side.STOCK)) revert BadSide();
        tokenAsset = IERC20(tokenAsset_);
        stockAsset = IERC20(stockAsset_);
        antiJitDelay = antiJitDelay_;
        isRewarder[owner_] = true;
        platformTreasury = owner_;
        hook = IHookWeightSink(hook_);
        poolId = poolId_;
        weightedSide = weightedSide_;
        hookWired = hook_ != address(0);
        // ETH is a default reward asset on the TOKEN side (and the STOCK side when it exists).
        _listReward(uint8(Side.TOKEN), ETH, 7 days);
        if (stockAsset_ != address(0)) _listReward(uint8(Side.STOCK), ETH, 7 days);
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
    /// [M-17] The try/catch this used to rely on did not make that true. try/catch catches reverts but NOT a
    /// failure to decode the return data — the decode runs in THIS frame after the call already succeeded, so an
    /// oracle returning fewer than 32 bytes reverted here despite the catch. `_reweigh` calls this on every
    /// stake, unstake and sync, so such an oracle froze every staker's PRINCIPAL, invisibly until someone tried
    /// to unstake. A low-level staticcall with a length check makes "never reverts" actually hold.
    function boostOf(uint8 side, address user) public view returns (uint256) {
        address oracle = address(boostOracle);
        if (oracle == address(0)) return BPS;
        (bool ok, bytes memory data) = oracle.staticcall(abi.encodeCall(IBoostOracle.boostBps, (side, user)));
        if (!ok || data.length < 32) return BPS;
        uint256 b = abi.decode(data, (uint256));
        if (b < BPS) return BPS;
        if (b > MAX_BOOST_BPS) return MAX_BOOST_BPS;
        return b;
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
            uint256 rate = (amount + leftover) / dur;
            // [M-20] A tranche too small to produce a non-zero rate must NOT open a live window at rate 0: that
            // is a zombie window an attacker can install for 1 wei and whose expiry they choose (the same shape
            // as C-1 one contract over). Park it instead — it is credited on the next tranche.
            if (rate == 0) {
                r.pending += amount;
                return;
            }
            r.rewardRate = rate;
            r.periodFinish = uint64(block.timestamp + dur);
        } else {
            uint256 remaining = r.periodFinish - block.timestamp;
            // [M-20] Floor the scheduling window. Dividing by `remaining` is what let a donation land in the tail
            // and pay out over seconds. periodFinish still cannot be stretched beyond now + MIN_DRIP_WINDOW, so
            // the anti-dust property the original comment protected survives — and a sub-rate amount is parked
            // by the branch above, so dust never reaches here at all.
            uint256 window = remaining < MIN_DRIP_WINDOW ? MIN_DRIP_WINDOW : remaining;
            uint256 rate = ((remaining * r.rewardRate) + amount) / window;
            if (rate == 0) {
                r.pending += amount;
                return;
            }
            r.rewardRate = rate;
            r.periodFinish = uint64(block.timestamp + window);
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
        // [audit M2] The hook notification is a reward-side side effect — it must NEVER be able to block
        // principal movement (stake/unstake both call _reweigh). Mirror the boostOracle try/catch so a
        // paused / upgraded-to-reverting / de-listed hook can't freeze a staker's principal.
        if (hookWired && side == weightedSide) {
            try hook.onWeightChange(poolId, user, nw) {}
            catch { emit WeightSyncFailed(side, user, nw); }
        }
    }

    // ─────────────────────────────────────────────────────── user actions ──

    function stake(uint8 side, uint256 amount) external nonReentrant {
        _requireSide(side);
        if (amount == 0) revert Zero();
        IERC20 asset = _stakeAsset(side);
        if (address(asset) == address(0)) revert SideDisabled(); // e.g. STOCK side on a single-book pool
        _updateReward(side, msg.sender);
        uint256 balBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = asset.balanceOf(address(this)) - balBefore;
        if (received == 0) revert Zero();
        staked[side][msg.sender] += received;
        totalStaked[side] += received;
        // [audit C1] Staked principal is part of the contract's accounted balance. Counting it here
        // keeps the invariant accountedReserve[asset] == balanceOf(asset), so the pushed-funding path
        // (received = balanceOf - accountedReserve) can NEVER mistake principal for an arrived reward —
        // critical when a stake asset is also a listed reward on the other side ("earn the other").
        accountedReserve[address(asset)] += received;
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
        // [audit C1] mirror the stake-time accounting: principal leaving the contract lowers the reserve.
        accountedReserve[address(_stakeAsset(side))] -= amount;
        _stakeAsset(side).safeTransfer(msg.sender, amount);
        emit Unstaked(side, msg.sender, amount);
    }

    /// @notice Claim one asset on one side. Single-asset so a paused/blocked reward leg only ever
    /// blocks its own claim, never the others, and never the principal.
    /// @return net the amount paid to the staker (after the platform claim fee, if any).
    function claim(uint8 side, address asset) public nonReentrant returns (uint256 net) {
        _requireSide(side);
        _updateReward(side, msg.sender);
        uint256 amount = rewardsAccrued[side][asset][msg.sender];
        if (amount == 0) revert Zero();
        rewardsAccrued[side][asset][msg.sender] = 0;
        // Platform cut of the reward (NO lock, principal untouched). Accrue-and-pull to the treasury.
        // [M-16] This applies to EVERY reward a staker claims, whatever funded it. There is no per-tranche
        // provenance in the accumulator, so a donation cannot be exempted here — see donateETH's note.
        uint256 fee = (amount * platformClaimFeeBps) / BPS;
        net = amount - fee;
        if (fee > 0) {
            platformFeesOwed[asset] += fee;
            emit PlatformClaimFeeTaken(asset, fee);
        }
        _payout(asset, msg.sender, net);
        emit Claimed(side, msg.sender, asset, net);
    }

    /// @notice Pull the accrued platform claim-fee for one asset to the treasury. Permissionless.
    function claimPlatformFees(address asset) external nonReentrant returns (uint256 amount) {
        amount = platformFeesOwed[asset];
        if (amount == 0) revert Zero();
        platformFeesOwed[asset] = 0;
        _payout(asset, platformTreasury, amount);
        emit PlatformFeesClaimed(asset, platformTreasury, amount);
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
        if (!rewardInfo[side][ETH].listed) revert NotListed(); // [AUDIT] a disabled side can never stream → would strand
        if (msg.value == 0) revert Zero();
        _updateReward(side, address(0));
        _applyReward(side, ETH, msg.value, true);
        emit RewardAdded(side, ETH, msg.value, totalWeight[side] > 0);
    }

    /// @notice Permissionless ETH top-up of a side's reward stream — anyone (typically the CREATOR) can deposit
    /// ETH straight to holders WITHOUT being a rewarder. Accounting-only.
    /// [M-16] This used to add "and WITHOUT touching the platform cut". That was false on the payout side, and
    /// the accumulator cannot be made to honour it. The exemption is real but applies to the DEPOSIT ONLY: no
    /// rewarder gate, no fee taken here. Once deposited, the ETH is indistinguishable from every other tranche —
    /// `fundETH`, `fundToken`, `fundTokenPushed`, `receive()`, this function, and the forfeit recycle in
    /// `unstake` all credit ONE per-(side,asset) accumulator with no per-tranche provenance — and `claim` takes
    /// `platformClaimFeeBps` of whatever a staker withdraws from it. So donated ETH is subject to the claim fee
    /// exactly like any other reward, and a donor cannot be promised otherwise without per-tranche accounting
    /// this contract deliberately does not have. `platformClaimFeeBps` is owner-settable up to
    /// MAX_CLAIM_FEE_BPS and defaults to 0, so the shortfall is whatever the operator has set at claim time.
    /// [AUDIT] Two guards make un-gated donations safe: (1) require the side's ETH stream is LISTED — a donation
    /// to a disabled side (e.g. STOCK on a single-book pool) can never be staked or kickstarted and would strand
    /// forever; (2) pass extend=FALSE so a donation TOPS UP the live stream rather than resetting the window,
    /// which stops a spammer perpetually re-stretching it.
    /// [M-20] The original note claimed extend=FALSE means periodFinish "can NEVER be pushed out". That was false
    /// twice over: across a LAPSED window the first branch runs regardless of `extend` and sets a fresh
    /// periodFinish, and within a live window the residue divisor let a tail donation stream over seconds. Both
    /// are fixed in _applyReward (sub-rate amounts park; the window is floored at MIN_DRIP_WINDOW), so the
    /// anti-spam intent now holds without handing a JIT staker the gift.
    function donateETH(uint8 side) external payable nonReentrant {
        _requireSide(side);
        if (!rewardInfo[side][ETH].listed) revert NotListed(); // side must be able to actually stream ETH
        if (msg.value == 0) revert Zero();
        _updateReward(side, address(0));
        _applyReward(side, ETH, msg.value, false); // top-up only — never extend/reset the period
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
        // [L-2] PERMISSIONLESS when the attribution is UNAMBIGUOUS. This is pure measured-delta accounting
        // — `received = balanceOf - accountedReserve` — so a stranger's poke can only ever credit tokens ALREADY
        // transferred in; it can never move value or credit thin air. The old blanket NotRewarder gate was
        // load-bearing only under M-13's extend=TRUE (gone now), and it broke the documented recovery:
        // RobinCurveV4.flushStaking() calls this UN-caught (RobinCurveV4.sol ~L457), so on a DualStaking sink the gate
        // reverted NotRewarder for every caller. fundToken (transferFrom) and fundETH (msg.value) KEEP their gate.
        if (asset == ETH) revert BadAsset();
        if (!rewardInfo[side][asset].listed) revert NotListed();
        // [re-audit] `accountedReserve` is keyed per-ASSET, and `side` is caller-asserted — so if `asset` is listed on
        // BOTH sides (the "earn the other" config), a stranger could name either side and misattribute the arrived
        // delta to the wrong book (theft of reward attribution between stakers). Only a trusted rewarder — who pushes
        // for a KNOWN side — may resolve that ambiguity. When `asset` is listed on a single side the attribution is
        // unambiguous and the push stays permissionless (this is the flushStaking() recovery path: TOKEN, pad token).
        if (rewardInfo[side == 0 ? 1 : 0][asset].listed && !isRewarder[msg.sender]) revert NotRewarder();
        uint256 bal = IERC20(asset).balanceOf(address(this));
        received = bal - accountedReserve[asset];
        if (received == 0) revert Zero();
        accountedReserve[asset] = bal;
        _updateReward(side, address(0));
        // [M-13] extend=FALSE. This path is triggered by RELAYS whose push is callable by anyone:
        // RobinCurveV4.flushStaking() is permissionless with no once-only guard, and
        // RobinAmbushVault.collectFees()/flushFees() realize LP fees and forward them on any caller's poke. With
        // extend=TRUE each such poke re-armed periodFinish to now + duration and re-divided the WHOLE undripped
        // reservoir over a fresh full window, so a stranger could stall the stream indefinitely for dust — and
        // the re-division truncated up to `duration - 1` base units of the reservoir every time. Topping up the
        // live window instead cannot stall it, and conserves value: the else branch's `remaining * rewardRate`
        // is exactly divisible by `remaining`, so the only loss is `amount mod window` — a 1-wei poke can lose
        // at most its own wei. See the concentration note on `MIN_DRIP_WINDOW` for what this trades against.
        _applyReward(side, asset, received, false);
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

    /// [M-17] Require code at set time. It does not make the read safe on its own — boostOf's staticcall does
    /// that — but it removes the commonest way in: an EOA, or a CREATE2 address for an oracle not yet deployed.
    /// (address(0) stays legal and means "no boost": boostOf short-circuits to BPS before any call.)
    function setBoostOracle(address oracle) external onlyOwner {
        if (oracle != address(0) && oracle.code.length == 0) revert BadParam();
        boostOracle = IBoostOracle(oracle);
        emit BoostOracleSet(oracle);
    }

    function setAntiJitDelay(uint32 delay) external onlyOwner {
        if (delay > MAX_ANTI_JIT) revert BadParam();
        antiJitDelay = delay;
        emit AntiJitDelaySet(delay);
    }

    function setPlatformClaimFee(uint16 bps) external onlyOwner {
        if (bps > MAX_CLAIM_FEE_BPS) revert BadParam();
        platformClaimFeeBps = bps;
        emit PlatformClaimFeeSet(bps);
    }

    function setPlatformTreasury(address treasury) external onlyOwner {
        if (treasury == address(0)) revert Zero();
        platformTreasury = treasury;
        emit PlatformTreasurySet(treasury);
    }

    /// @notice [audit L5] Disabled — renouncing would brick every reward/config setter on this pool.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
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
        // [M-13] extend=FALSE for the same reason as fundTokenPushed: a rewarder here may be a relay whose send
        // is triggered by an arbitrary caller. No contract in this suite currently sends ETH to a DualStaking,
        // so this is defensive — but RobinAmbushVault's floorRecipient is an unvalidated immutable reached from
        // a permissionless flush, so the shape is one wiring away from being live.
        _applyReward(uint8(Side.TOKEN), ETH, msg.value, false);
        emit RewardAdded(uint8(Side.TOKEN), ETH, msg.value, totalWeight[uint8(Side.TOKEN)] > 0);
    }
}
