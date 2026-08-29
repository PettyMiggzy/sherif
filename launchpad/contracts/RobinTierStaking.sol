// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Where a pool reads a staker's $ROBIN position from, for the holder boost. The flagship $ROBIN pool
/// points this at itself; every other pool points it at the flagship.
interface IBoostSource {
    /// @notice $ROBIN the user has LOCKED — flexible positions do not count. See `stakedLockedOf`.
    function stakedLockedOf(address user) external view returns (uint256);
}

/// @title RobinTierStaking — locked-tier, weighted staking with an early-exit tax
/// @notice Stake one token (the flagship $ROBIN, or any coin launched on the pad) and earn a basket of reward
/// assets — native ETH and/or ERC-20s. This is the tiered successor to `RobinStaking`, and the differences are
/// deliberate rather than incidental:
///
///   1. LOCK TIERS. A stake picks a term — flexible, 7, 30, 60, 90, 180 or 365 days — and the term sets a
///      MULTIPLIER on the share of rewards it earns. Longer term, bigger share. Staking more earns more for
///      free, because share is amount x multiplier; there is deliberately no separate size bonus, which would
///      only hand whales a second advantage on top of the one they already have.
///
///   2. YOU CAN ALWAYS LEAVE — AT A PRICE. A lock here is a price, never a cage. `withdraw` on an immature
///      position always succeeds, and it costs EARLY_EXIT_BPS of that position's principal. That is the
///      entire penalty: rewards already earned stay earned. A hard lock that can trap someone's money is the
///      single scariest thing a staking contract can do, and the point of a term is to price impatience, not
///      to imprison anyone.
///
///      An earlier version also forfeited pending rewards, and it was removed rather than fixed. `claim` does
///      not forfeit, so anyone who knew to claim before withdrawing kept everything and paid only the 15%;
///      the forfeit landed solely on people who did not know that, which is the opposite of who a penalty
///      should reach. One penalty, stated plainly, applied identically to everyone who reads it or does not.
///
///   3. EARLY EXITS PAY THE STAYERS — AND NEVER THEMSELVES, INCLUDING NOT VIA A SECOND WALLET. The exit
///      tax is booked into the pot at the moment of the exit and pays nobody in that block. It reaches
///      the stayers when the pot is released, streamed over a reward window.
///
///      That indirection is not caution, it is two measured exploits. Paying an instant lump to
///      whoever holds weight in the exit block let a FLEXIBLE staker — no lock, no exit tax — stake in
///      that block, take 80% of a 150,000 penalty and leave free in the next call. And excluding the
///      leaver only works per ADDRESS: a leaver who was the whole pool opened a second wallet holding
///      one wei and collected the entire penalty back, with nothing stranded. Neither survives when
///      the exit block is worth nothing.
///      Without that exclusion a staker who is most of the pool receives most of their own penalty back, and
///      the 15% quietly stops applying to exactly the holders it matters most for. In the normal case nothing
///      goes to the platform or the owner — there is no path that sends either one to a wallet.
///
///      One case needs handling rather than a claim: a penalty collected when there is NOBODY ELSE STAKED. It
///      cannot go to the stayers because there are none, and parking it for "the next staker" just hands it
///      back to the leaver, who is the next staker. So it accumulates in `stranded` — a visible pot, readable
///      by any front end via `strandedAll` — and is swept to `strandedSink`. Handing it back to stakers was
///      tried three times and broken three times; see `sweepStranded` for the measurements. The penalty is
///      real, it leaves the leaver for good, and it no longer feeds a race.
///
///   4. THE $ROBIN HOLDER BOOST. Hold at least `boostThreshold` $ROBIN — STAKED, see below — and every
///      position you hold in this pool earns a further `boostBps` on top of its tier. It applies across every
///      pool, because every pool reads the same source.
///
/// WHY THE BOOST COUNTS *LOCKED* $ROBIN AND NOT A WALLET BALANCE, OR EVEN A STAKED ONE. A balance check is
/// measured in one instant, and one instant is buyable: flash-borrow ten million $ROBIN, call the function
/// that snapshots you, repay in the same transaction.
///
/// Requiring it to be STAKED is not enough on its own, and that was a real hole rather than a theoretical
/// one: a FLEXIBLE position costs nothing to open and nothing to close, so the whole sequence — borrow,
/// stake flexible, `syncBoost` a satellite pool which caches the resulting weight, unstake, repay — fits in
/// one transaction. It was measured doing exactly that, leaving a satellite pool showing a live boost behind
/// zero staked $ROBIN. So the boost reads `stakedLockedOf`: principal under a LIVE lock. Renting that costs
/// EARLY_EXIT_BPS to unwind, which is the point — the boost is for people carrying risk, and a lock is what
/// carrying risk looks like here. `syncBoost` stays permissionless so a boost that has stopped being
/// deserved can always be removed by somebody.
///
/// JIT (stake right before a reward lands, grab a slice, leave) is defeated by streaming: every reward runs
/// linearly over a window rather than dropping as a lump, so a flash staker accrues only the sliver that
/// streams during their stay. Exit penalties go through the pot for the same reason — see `_penalise`, and
/// note that the ONE thing this contract used to pay as an instant lump was the one thing JIT could take.
///
/// Accounting is the Synthetix `rewardPerToken` accumulator, one per reward asset, run over WEIGHT rather than
/// principal. O(#rewardAssets) per user action and O(#positions) per withdraw, both capped.
contract RobinTierStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant ACC = 1e30; // accumulator fixed-point scale
    uint16 private constant BPS = 10_000;
    /// @notice Native ETH as a reward asset. Public because it appears verbatim in `getRewardTokens()`, and a
    /// front end or keeper that treats every listed asset as an ERC-20 will call `balanceOf` on address zero
    /// and get a silent empty return rather than a revert. Exposing the sentinel lets callers branch on it.
    address public constant ETH = address(0);

    uint256 public constant MAX_REWARD_TOKENS = 16;
    /// @dev Cap on open positions per user. `withdraw` and the weight recompute walk this list, so it must be
    /// bounded or a user could grow their own position array until their exit runs out of gas — locking
    /// themselves out of a contract whose whole promise is that they can always leave.
    uint256 public constant MAX_POSITIONS = 24;

    uint32 public constant MIN_DURATION = 1 hours;
    uint32 public constant MAX_DURATION = 365 days;

    /// @notice Early exit costs this share of PRINCIPAL, redistributed to the stakers who stayed.
    uint16 public constant EARLY_EXIT_BPS = 1_500; // 15%

    IERC20 public immutable stakeToken;

    // ── tiers ────────────────────────────────────────────────────────────────
    // Fixed at deploy and never changeable. A mutable multiplier would let an owner re-price a lock somebody
    // has already committed to and cannot leave without paying — so the schedule is immutable, and a position
    // additionally carries the multiplier it was opened at (see Position.mulBps) so even a future contract
    // cannot retroactively re-rate it.
    uint32[7] public TIER_TERM = [uint32(0), 7 days, 30 days, 60 days, 90 days, 180 days, 365 days];
    uint16[7] public TIER_MUL_BPS = [uint16(10_000), 11_000, 12_500, 15_000, 20_000, 30_000, 50_000];

    // ── boost ────────────────────────────────────────────────────────────────
    IBoostSource public boostSource; // where a staker's $ROBIN position is read from
    uint256 public boostThreshold = 10_000_000 ether; // 10M $ROBIN
    uint16 public boostBps = 2_500; // +25% on top of the tier multiplier

    // ──────────────────────────────────────────────────────── the whale cap ──
    //
    // WHY THIS EXISTS. Rewards are split by weight, so more capital takes more — which is how staking is
    // supposed to work, until one account takes the pool. Measured before this cap: a whale staking 50x the
    // only locked staker, with no lock at all, took 90.9% of a reward. The locked staker who had committed
    // for a year got 9.1%. Nothing was stolen and nothing was broken; it was simply not a pool anyone else
    // had a reason to join.
    //
    // So one account's PRINCIPAL is capped relative to everyone else's. Principal, not weight, and the
    // distinction is the whole design. Capping weight looked equivalent and was not: weight already carries
    // the tier multiplier and the holder boost, so a weight cap silently ate them. A staker who locked for
    // 365 days is supposed to earn 5x what an unlocked one earns on the same money, and under a weight cap
    // that collapsed to 2x — the cap could not tell "5x because I committed for a year" from "5x because I
    // brought five times the money", and punished the first to reach the second. Capping the money and
    // letting the multipliers run on top keeps every promise the pool makes and still bounds size.
    //
    // Relative rather than a fixed number of tokens, because a fixed number cannot be right for both a pool
    // holding 0.1% of a supply and one holding 20% of it, and the thin pool is exactly where a whale does
    // the most damage. It is computed against OTHER people's principal — `totalStaked - stakedOf[user]` —
    // which is what keeps it from being circular: your cap never depends on your own capped figure.
    //
    // WHAT IT DOES NOT DO. It does not stop a whale who splits across wallets. Nothing on-chain can: an
    // address costs nothing, and every per-account limit ever written has the same hole. What it does is
    // make domination cost either real work (fund, stake, claim and manage N wallets on every pool, forever)
    // or real $ROBIN. The second path is deliberately the cheap one — see `capStepBps`.
    // The number errs loose on purpose. Bringing three times what everyone else brought is not whaling, it
    // is being the biggest holder, and it should pay three times — so the ceiling sits far above ordinary
    // variance and only bites genuine domination. At 10x, every normal case measured here is untouched and
    // the whale that caused all this — 50x the only other staker — drops from 90.9% of a reward to 66.7%.
    uint32 public capBps = 100_000; // your principal may reach 10x everyone else's combined; 0 disables it

    /// @notice $ROBIN locked per step of extra cap. Locking this much raises your ceiling by `capStepBps`.
    /// @notice The base allowance for an account when NOBODY ELSE has committed principal — see `_capFor`.
    ///         Absolute and fixed at construction, at 0.001% of the stake token's supply, because a relative
    ///         ceiling is meaningless with nothing to be relative to and "no ceiling" is how the cap was
    ///         defeated. Deliberately small: it has to bind on a whale that stakes first into a fresh pool.
    uint256 public immutable capFloor;

    uint256 public capStep = 10_000_000e18;
    /// @notice How much each step adds, in bps of `capBps`. Default +50% of the base allowance per step.
    uint32 public capStepBps = 5_000;
    /// @notice The most the steps can add, in bps of everyone else's committed principal. Default +400%,
    ///         which on top of the 1000% base is a ceiling of 14x — NOT 50x. An earlier version of this
    ///         comment said "5x the base allowance", read the 400% as a multiplier rather than an addend and
    ///         overstated the $ROBIN incentive by a factor of ten. The code was always the restrictive one.
    uint32 public capMaxBps = 40_000;

    /// @notice A rail on `capBps + capMaxBps`, mirroring what MAX_BOOST_BPS does for the boost. Without it
    ///         nothing stopped a future owner from "correcting the docs" by multiplying the parameters and
    ///         moving the ceiling to 50x, which is the same as having no cap on any pool that matters.
    uint32 public constant MAX_CAP_TOTAL_BPS = 200_000; // 20x everyone else, all sources combined
    /// @dev A ceiling the owner cannot raise. Governance may tune the boost, but it can never become so large
    /// that boosted stakers effectively own the whole stream and everyone else earns nothing.
    uint16 public constant MAX_BOOST_BPS = 10_000; // +100%

    struct Position {
        uint128 amount; // principal
        uint64 unlockAt; // 0 for the flexible tier
        uint16 mulBps; // the tier multiplier this position was opened at, frozen here
        uint8 tier;
    }

    mapping(address => Position[]) private _positions;
    mapping(address => uint256) public stakedOf; // raw principal, the number a user withdraws against
    mapping(address => uint256) public weightOf; // amount x tier x boost — what actually earns
    mapping(address => bool) public boosted; // whether weightOf currently includes the boost
    uint256 public totalStaked;

    /// @notice Principal held in positions that PICKED A TERM — every tier except flexible. Maintained on
    /// stake and withdraw only, so unlike "currently locked" it needs no clock and can never go stale.
    ///
    /// This is the whale cap's denominator, and it is not `totalStaked` for the same reason the holder boost
    /// reads `stakedLockedOf` instead of `stakedOf`: flexible principal is FLASH-RENTABLE. It can be borrowed,
    /// staked, counted, and withdrawn inside one transaction at no cost, so any limit measured against it can
    /// be manufactured away on demand. Measured on the version this replaces: a dummy flash-staking 60M
    /// flexible, then calling the permissionless `syncBoost(whale)` while the denominator was inflated,
    /// recomputed an honestly-capped whale at 500x its ceiling and left it there — turning the function that
    /// exists to collapse a stale whale into the tool that uncaps one. It then took 99.9% of the stream, and
    /// could redo it every reward window for a one-block flash fee.
    ///
    /// A term position cannot be rented the same way: closing one early costs 15% of the principal, so the
    /// attack above would cost 9M tokens instead of a flash fee. Maturity is deliberately NOT checked — a
    /// matured term position still counts. Checking it would put a clock back in the denominator, and a
    /// denominator that changes with no transaction to observe it is exactly the staleness this is fixing.
    uint256 public totalCommitted;
    mapping(address => uint256) public committedOf;
    uint256 public totalWeight; // the accumulator's denominator

    struct RewardInfo {
        bool listed;
        uint32 duration;
        uint64 periodFinish;
        uint64 lastUpdateTime;
        uint256 rewardRate;
        uint256 rewardPerTokenStored;
        uint256 pending; // arrived while the pool was empty; streams on the next stake
    }

    address[] public rewardTokens;
    mapping(address => RewardInfo) public rewardInfo;
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid;
    mapping(address => mapping(address => uint256)) public rewardsAccrued;
    mapping(address => bool) public isRewarder;

    /// @notice Every early-exit tax collected — the pot. It is held here rather than in `pending` because
    /// `pending` streams to whoever stakes next, and on an empty pool that is the person who just paid the
    /// tax. See `sweepStranded` for why it goes to a sink instead of back to the stayers.
    ///
    /// It is deliberately readable (`strandedAll`) so a front end can show the pot growing, and it leaves
    /// only through `sweepStranded`. See that function for why it no longer goes back to stakers.
    mapping(address => uint256) public stranded;
    /// @notice The only destination the pot has. Set to the deployer at construction — which for a pool
    /// built by `RobinTierStakingFactory` is the FACTORY, so the factory re-points it at the real owner in
    /// the same transaction. Point it at a
    /// treasury or at the burn address. `sweepStranded` takes no recipient argument.
    address public strandedSink;

    error Zero();
    error BadTier();
    error NoPosition();
    error TooManyPositions();
    error NotListed();
    error AlreadyListed();
    error TooManyRewards();
    error NotRewarder();
    error BadDuration();
    error BadBoost();
    error EthTransferFailed();
    error NothingStranded();
    error BadCap();
    error StreamRunning(uint64 until);

    event Staked(address indexed user, uint256 indexed positionId, uint256 amount, uint8 tier, uint64 unlockAt);
    event Withdrawn(address indexed user, uint256 indexed positionId, uint256 returned, uint256 tax, bool early);
    event Claimed(address indexed user, address indexed asset, uint256 amount);
    event RewardAdded(address indexed asset, uint256 amount, uint64 periodFinish);
    event RewardListed(address indexed asset, uint32 duration);
    event BoostChanged(address indexed source, uint256 threshold, uint16 bps);
    event CapSet(uint32 capBps, uint256 capStep, uint32 capStepBps, uint32 capMaxBps);
    event BoostSynced(address indexed user, bool boosted, uint256 weight);
    event Stranded(address indexed asset, uint256 amount);
    event StrandedSwept(address indexed asset, address indexed to, uint256 amount);
    event StrandedSinkChanged(address indexed sink);

    constructor(address stakeToken_, address owner_, address boostSource_) Ownable(owner_) {
        if (stakeToken_ == address(0)) revert Zero();
        stakeToken = IERC20(stakeToken_);
        isRewarder[owner_] = true;
        strandedSink = owner_;

        // The fallback ceiling for a pool nobody has committed to yet. 1% of supply, read once and frozen.
        // try/catch because `listReward` accepts any ERC-20 and a stake token that does not answer
        // `totalSupply` must not make the pool undeployable; a zero floor simply means the relative ceiling
        // is the only one, which is the behaviour this replaces rather than something worse.
        uint256 sup;
        try IERC20(stakeToken_).totalSupply() returns (uint256 t) { sup = t; } catch { sup = 0; }
        capFloor = sup / 100_000;
        // The staked token is listed up front because the early-exit tax is paid IN it — without a stream to
        // pay into, the tax would have nowhere to go.
        _listReward(address(stakeToken_), 7 days);
        _listReward(ETH, 7 days);
        // address(0) is legal and means "no boost source yet" — the flagship pool points this at itself right
        // after deployment, which it cannot do inside its own constructor.
        boostSource = IBoostSource(boostSource_);
    }

    // ─────────────────────────────────────────────────────────────── views ──

    function positionsOf(address user) external view returns (Position[] memory) {
        return _positions[user];
    }

    function positionCount(address user) external view returns (uint256) {
        return _positions[user].length;
    }

    /// @notice Principal the user has under a LIVE LOCK. This, not the raw balance, is what the
    /// holder boost reads.
    ///
    /// FLEXIBLE POSITIONS ARE EXCLUDED AND THAT IS THE ENTIRE POINT. Counting them made the boost
    /// buyable for one transaction: flash-borrow 10M $ROBIN, open a flexible position in this pool,
    /// call `syncBoost` on a satellite pool — which reads this number and CACHES the resulting
    /// weight — then close the flexible position and repay, all in one call. Measured: the
    /// satellite still showed boosted = true with zero staked $ROBIN behind it. A flexible position
    /// costs nothing to open and nothing to close, so anything that trusts it is trusting a number
    /// that can be rented for a block.
    ///
    /// A locked position cannot be rented that way: leaving it early costs EARLY_EXIT_BPS of the
    /// principal, so borrowing 10M to fake a boost now costs 1.5M. The boost is meant to be earned
    /// by people carrying risk, and a lock is what carrying risk looks like here.
    function stakedLockedOf(address user) public view returns (uint256 locked) {
        Position[] storage ps = _positions[user];
        for (uint256 i; i < ps.length; ++i) {
            if (ps[i].unlockAt > block.timestamp) locked += ps[i].amount;
        }
    }

    function rewardTokensLength() external view returns (uint256) {
        return rewardTokens.length;
    }

    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokens;
    }

    /// @dev Gas handed to the boost source. `staticcall` already blocks it from writing anything, but it does
    /// NOT stop it from BURNING gas, and that distinction is the whole finding: without a cap, a boost source
    /// that loops forever consumes 63/64 of the gas in the frame and leaves the caller too little to finish.
    /// `ok` comes back false and the code looks like it handled it — but `stake` and, far worse, `withdraw`
    /// both revert out of gas at any sane gas limit. The contract's headline promise is that leaving is always
    /// possible; an owner-set address that can take that away is not a promise. The cap makes the failure
    /// local: the call dies, `qualifiesForBoost` returns false, and the withdrawal completes unboosted.
    ///
    /// SIZED AGAINST THE REAL WORST CASE, not guessed. The flagship pool answers this call with
    /// `stakedLockedOf`, which walks the caller's positions — and at MAX_POSITIONS (24) that measured
    /// 92,395 gas against the old 100,000 cap: 7.6% of headroom. Exceeding it does not revert, it
    /// silently returns false, so the failure mode was "the boost quietly stops working for exactly
    /// the biggest stakers" — the ones most likely to have 24 positions and most likely to notice
    /// they are being shortchanged without being able to say why.
    ///
    /// 250k restores real margin while still bounding a hostile source: a withdraw with 24 positions
    /// costs ~201k in total, so even a boost source that burns every drop of this cannot come close
    /// to making an exit unaffordable.
    uint256 private constant BOOST_GAS = 250_000;

    /// @dev How much $ROBIN `user` has LOCKED, read live from the boost source. Both the holder boost and
    /// the whale cap are priced off this one number, so it is read once and shared — a second staticcall
    /// would double the cost of every stake for no new information.
    ///
    /// Gas-capped as well as static, so a broken or hostile source can cost a staker their boost and their
    /// raised cap, but never their exit. See BOOST_GAS. A failed read is treated as zero rather than a
    /// revert for the same reason: nothing about an outside contract may be able to trap a withdrawal.
    function _lockedRobin(address user) internal view returns (uint256) {
        if (address(boostSource) == address(0)) return 0;
        (bool ok, bytes memory ret) =
            address(boostSource).staticcall{gas: BOOST_GAS}(abi.encodeCall(IBoostSource.stakedLockedOf, (user)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @notice Whether `user` currently qualifies for the holder boost, read live from the source.
    function qualifiesForBoost(address user) public view returns (bool) {
        if (address(boostSource) == address(0) || boostBps == 0) return false;
        return _lockedRobin(user) >= boostThreshold;
    }

    function _lastTimeApplicable(address asset) internal view returns (uint256) {
        uint256 pf = rewardInfo[asset].periodFinish;
        return block.timestamp < pf ? block.timestamp : pf;
    }

    function rewardPerToken(address asset) public view returns (uint256) {
        RewardInfo storage r = rewardInfo[asset];
        if (totalWeight == 0) return r.rewardPerTokenStored;
        uint256 tApp = _lastTimeApplicable(asset);
        if (tApp <= r.lastUpdateTime) return r.rewardPerTokenStored;
        return r.rewardPerTokenStored + Math.mulDiv((tApp - r.lastUpdateTime) * r.rewardRate, ACC, totalWeight);
    }

    /// @notice Unclaimed reward of `user` in `asset` — what `claim` pays. An early withdraw does not touch it.
    function earned(address user, address asset) public view returns (uint256) {
        uint256 delta = rewardPerToken(asset) - userRewardPerTokenPaid[asset][user];
        return rewardsAccrued[asset][user] + Math.mulDiv(weightOf[user], delta, ACC);
    }

    /// @notice The pot, per reward asset, in one call — so a front end can show it without N round trips.
    function strandedAll() external view returns (address[] memory assets, uint256[] memory amounts) {
        assets = rewardTokens;
        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) amounts[i] = stranded[assets[i]];
    }

    function earnedAll(address user) external view returns (address[] memory assets, uint256[] memory amounts) {
        assets = rewardTokens;
        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) amounts[i] = earned(user, assets[i]);
    }

    // ──────────────────────────────────────────────── internal accounting ──

    /// @dev Advance every accumulator to now and settle `account`. Math only — it never transfers, so a paused
    /// or malicious reward asset can never brick a stake or a withdrawal.
    function _updateReward(address account) internal {
        bool empty = totalWeight == 0;
        uint256 len = rewardTokens.length;
        for (uint256 i; i < len; ++i) {
            address asset = rewardTokens[i];
            RewardInfo storage r = rewardInfo[asset];
            if (empty) {
                // A live stream must not keep streaming into an empty pool — those rewards would credit
                // nobody and strand forever. Capture the un-streamed remainder back into `pending`; the next
                // stake re-streams it over a fresh window, which is lossless and still not a lump.
                if (r.rewardRate > 0 && r.periodFinish > r.lastUpdateTime) {
                    r.pending += (r.periodFinish - r.lastUpdateTime) * r.rewardRate;
                    r.rewardRate = 0;
                    r.periodFinish = uint64(block.timestamp);
                }
                r.lastUpdateTime = uint64(block.timestamp);
            } else {
                r.rewardPerTokenStored = rewardPerToken(asset);
                r.lastUpdateTime = uint64(_lastTimeApplicable(asset));
            }
            if (account != address(0)) {
                rewardsAccrued[asset][account] = earned(account, asset);
                userRewardPerTokenPaid[asset][account] = r.rewardPerTokenStored;
            }
        }
    }

    /// @notice How long the pool must have held ANY weight before parked rewards are released.
    ///
    /// Without this, rewards funded into an empty pool go to whoever stakes next, at ANY size, because
    /// that staker is briefly 100% of the denominator. Measured: ONE WEI captured 14,285 of a 100,000
    /// parked pot, and through the real feeder path a sniper netted 9.9997 of 10 ETH seeded into a
    /// fresh pool. That is not a curiosity here — the fee feeder pushes money into brand-new pools
    /// automatically, so it would be a standing, repeatable target on every coin ever launched.
    ///
    /// An hour is not a magic number. It is long enough that being first stops being decisive and
    /// anyone watching can join before the money starts moving.
    uint32 public constant PENDING_DELAY = 1 hours;

    /// @notice A top-up smaller than 1/this of the un-streamed remainder joins the running window rather
    ///         than restarting it. See `_applyReward` for why that matters when anyone can trigger a deposit.
    uint256 private constant DUST_TOPUP_RATIO = 100;
    /// @notice When the pool last went from empty to holding weight. Zero while it is empty.
    uint64 public weightSince;

    /// @dev Start any parked stream, once the pool has held weight long enough to be a real pool.
    function _kickstartPending() internal {
        if (totalWeight == 0) return;
        if (weightSince == 0 || block.timestamp < uint256(weightSince) + PENDING_DELAY) return;
        uint256 len = rewardTokens.length;
        for (uint256 i; i < len; ++i) {
            address asset = rewardTokens[i];
            RewardInfo storage r = rewardInfo[asset];
            if (r.pending > 0) {
                uint256 amt = r.pending;
                r.pending = 0;
                _applyReward(asset, amt, true);
            }
        }
    }

    /// @dev Fold `amount` into `asset`'s stream. `extend` rolls any un-streamed remainder in with it, so a
    /// top-up never shortens or strands the stream already running.
    function _applyReward(address asset, uint256 amount, bool extend) internal {
        RewardInfo storage r = rewardInfo[asset];
        if (amount == 0) return;
        if (totalWeight == 0) { r.pending += amount; return; }
        uint256 remaining;
        if (extend && block.timestamp < r.periodFinish) {
            remaining = (r.periodFinish - block.timestamp) * r.rewardRate;

            // A TOP-UP MUST NOT BE ABLE TO RESTART THE CLOCK FOR FREE. Every funding call below resets
            // `periodFinish` to now + duration and re-spreads whatever has not streamed yet. Funding is
            // gated, but `returnTax` on the feeder is deliberately open to anyone, and anyone may also
            // donate a token — so without this, a griefer sending one wei a day could hold `periodFinish`
            // permanently a full window away and thin the tail forever. Measured before this guard: five
            // daily pokes roughly halved the rate with the finish still 7.00 days out.
            //
            // So a top-up worth less than 1% of what is still owed is folded into the window ALREADY
            // running instead of starting a new one. Nothing is lost — the money is added to the same
            // rate over the same remaining time — the deposit simply does not buy the right to move the
            // finish line. Anything larger is a real deposit and extends normally.
            if (amount < remaining / DUST_TOPUP_RATIO) {
                uint256 left = r.periodFinish - block.timestamp;
                uint256 tot = amount + remaining;
                uint256 rate = tot / left;
                if (rate == 0) { r.pending += amount; return; }
                r.rewardRate = rate;
                unchecked { r.pending += tot - rate * left; }
                r.lastUpdateTime = uint64(block.timestamp);
                emit RewardAdded(asset, amount, r.periodFinish);
                return;
            }
        }
        uint256 total = amount + remaining;
        // A stream shorter than one wei per second rounds to a rate of ZERO, and then the money
        // streams to nobody: not credited, not pending, not stranded, and with no way back out.
        // Park it instead and let it go out with the next deposit. Harmless on an 18-decimal token
        // (under `duration` wei), but `listReward` accepts any ERC-20 and a 6-decimal reward makes
        // this a real amount.
        if (total / r.duration == 0) { r.pending += amount; return; }
        r.rewardRate = total / r.duration;
        // The division discards up to `duration - 1` base units on EVERY funding call, credited to
        // nobody, parked nowhere, and unrecoverable — there is no sweep for it. Dust on an 18-decimal
        // token; real money on a 6-decimal one, where a realistic weekly-drip campaign measured 844 of
        // 26,000 USDC permanently destroyed. Carried into `pending` so it leaves with the next deposit.
        unchecked { r.pending += total - (r.rewardRate * uint256(r.duration)); }
        r.lastUpdateTime = uint64(block.timestamp);
        r.periodFinish = uint64(block.timestamp + r.duration);
        emit RewardAdded(asset, amount, r.periodFinish);
    }

    /// @dev Book an early-exit penalty into the pot.
    ///
    /// THIS USED TO PAY THE STAYERS INSTANTLY, by bumping the per-weight accumulator in the same
    /// transaction as the exit and advancing the leaver's own checkpoint past the bump so they
    /// could not take a share of it. That was elegant and it was broken in two ways, both measured:
    ///
    ///   • JIT. An instant lump goes to whoever holds weight in THAT BLOCK. A flexible position has
    ///     no lock and no exit tax, so an attacker could stake 20M in the block of somebody's exit,
    ///     take 80% of a 150,000 penalty, and leave in the next call for free. The people the
    ///     penalty was meant to reward — the ones who stayed locked for months — got the remainder.
    ///
    ///   • SYBIL. The exclusion is per ADDRESS, and an address is free. A leaver who was the entire
    ///     pool used to have their penalty stranded, because there was nobody else to pay; opening a
    ///     SECOND WALLET with one wei made the denominator non-zero, so the strand never fired and
    ///     that wallet collected the whole 150,000 back. Measured exactly: 150,000 recaptured, 0
    ///     stranded.
    ///
    /// Both came from paying an instant lump to whoever held weight at one instant, so nothing is paid at
    /// the instant of the exit. What was tried next — streaming the pot back to stakers — failed too, to a
    /// front-run and to the leaver simply re-staking flexible. The pot now leaves through `sweepStranded`,
    /// which is documented there. What survives from all of it is the part that always worked: the 15% is
    /// taken, and it does not come back to the person who paid it.
    function _penalise(address asset, uint256 amount) internal {
        if (amount == 0) return;
        unchecked { stranded[asset] += amount; }
        emit Stranded(asset, amount);
    }

    /// @dev The ceiling on `user`'s earning weight. Measured against what everybody ELSE holds, so it scales
    /// with the pool instead of needing a number that suits every coin, and so it can never depend on the
    /// value it is about to bound.
    ///
    /// An empty pool has no ceiling — with nobody else staked there is no one to take a share from, and a
    /// cap of zero would mean the first staker earns nothing and the pool could never start.
    function _capFor(address user, uint256 robin) internal view returns (uint256) {
        if (capBps == 0) return type(uint256).max; // disabled

        uint256 robinAdd;
        if (capStep != 0 && robin != 0) {
            // Clamp the STEP COUNT before multiplying, not the product after. A boostSource is an outside
            // contract; one returning an absurd number with a small `capStep` would overflow the multiply and
            // revert `_resync`, which is on the path of every stake, claim and withdraw. Clamping first means
            // the worst a hostile source can do is hand somebody the maximum ceiling.
            uint256 steps = robin / capStep;
            uint256 maxSteps = capStepBps == 0 ? 0 : uint256(capMaxBps) / capStepBps;
            robinAdd = (steps > maxSteps ? maxSteps : steps) * capStepBps;
        }

        // Everyone ELSE's committed principal. Flexible principal is excluded on both sides — see
        // `totalCommitted` for the flash-rental attack that reading `totalStaked` here allowed.
        uint256 others = totalCommitted - committedOf[user];

        // NOBODY ELSE COMMITTED YET. This used to return NO CEILING, and it was the cheapest way through the
        // whole mechanism: stake first into a fresh pool, stay uncapped forever because a ceiling is only
        // recomputed when that account itself touches the pool again, and take 90.9% of everything once the
        // honest lockers arrived. Every coin that graduates creates an empty pool, so this was not luck, it
        // was a queue to stand in.
        //
        // A small absolute allowance instead. Small because it has to BIND on the whale that stands in that
        // queue, and a generous number would not — at 1% of supply it was larger than any realistic stake and
        // capped nobody. The cost is that a genuinely large first staker earns on this much until somebody
        // else commits, after which their real ceiling applies from their next touch (or anyone's
        // `syncBoost`). That is a poke for one honest account against a permanent bypass for every whale, and
        // it errs in the safe direction — staleness here can only ever RAISE a ceiling, never lower one.
        if (others == 0) {
            // NOBODY ELSE HAS COMMITTED. Whether that deserves a ceiling depends on what THIS account did.
            //
            // If it committed to a term, no ceiling. It is the only staker, so a ceiling protects nobody, and
            // capping it would punish the one person willing to be first — measured at a 100x throttle on an
            // honest opener, which is a worse problem than the one being solved. Getting out of that
            // commitment early still costs 15%, so this is not free to abuse.
            //
            // If it did not, the small absolute allowance. This is the case that used to return NO CEILING
            // and was the cheapest way through the whole mechanism: park flexible money in a fresh pool, stay
            // uncapped forever because a ceiling is only recomputed when its own account touches the pool
            // again, and take 90.9% once the honest lockers arrived. Every graduation creates an empty pool,
            // so it was not luck, it was a queue to stand in.
            //
            // The floor is the allowance itself, not a base for `capBps` to multiply — scaling it by 10x made
            // it too large to bind the very account it exists for. The $ROBIN step-up still applies, because
            // that is the one way a ceiling is meant to be raised.
            if (committedOf[user] != 0) return type(uint256).max;
            return capFloor + Math.mulDiv(capFloor, robinAdd, BPS);
        }

        uint256 bps = capBps + robinAdd;
        return Math.mulDiv(others, bps, BPS);
    }

    /// @notice The most PRINCIPAL `user` may currently earn on. Anything staked above it still belongs to
    /// them and still withdraws in full, it simply does not earn. Rendered on the stake page so somebody
    /// about to stake past their ceiling is told before they do it, not after.
    function capOf(address user) external view returns (uint256) {
        return _capFor(user, _lockedRobin(user));
    }

    /// @dev Recompute `user`'s weight from their positions and current boost status, and move `totalWeight`
    /// with it. The caller MUST have settled rewards for `user` first, or the change is applied retroactively
    /// to rewards already earned at the old weight.
    function _resync(address user) internal {
        Position[] storage ps = _positions[user];
        uint256 robin = _lockedRobin(user); // one read, shared by the boost and the cap
        bool boost = boostBps != 0 && address(boostSource) != address(0) && robin >= boostThreshold;
        uint256 w;
        for (uint256 i; i < ps.length; ++i) {
            // The multiplier frozen ON THE POSITION, never the current tier table — a position is priced by
            // the deal it was opened under.
            w += Math.mulDiv(ps[i].amount, ps[i].mulBps, BPS);
        }

        // The cap applies to PRINCIPAL and BEFORE the multipliers, so a capped staker keeps the full tier
        // and boost rate on the part that does count — see the note on `capBps` for why capping the weight
        // instead quietly cancelled the tiers. Scaling the whole weight by cap/principal rather than
        // trimming positions keeps the mix of tiers intact: an account over its ceiling has every position
        // counted at the same fraction, so which one it opened first does not change what it earns.
        //
        // Principal is untouched by any of this. It lives in the positions and withdraws in full — an
        // account above its ceiling is earning less, never stuck.
        uint256 principal = stakedOf[user];
        uint256 cap = _capFor(user, robin);
        if (principal > cap && principal != 0) w = Math.mulDiv(w, cap, principal);

        if (boost) w += Math.mulDiv(w, boostBps, BPS);

        uint256 prevTotal = totalWeight;
        totalWeight = totalWeight - weightOf[user] + w;
        weightOf[user] = w;
        boosted[user] = boost;
        // The clock starts when the pool stops being empty and clears when it empties again, so a pool
        // that briefly empties cannot be used to reset somebody else's wait.
        if (prevTotal == 0 && totalWeight > 0) weightSince = uint64(block.timestamp);
        else if (totalWeight == 0) weightSince = 0;
    }

    // ─────────────────────────────────────────────────────────────── stake ──

    /// @notice Open a position of `amount` at `tier`. Tier 0 is flexible (no lock, no early-exit tax).
    function stake(uint256 amount, uint8 tier) external nonReentrant returns (uint256 positionId) {
        if (amount == 0) revert Zero();
        if (tier >= TIER_TERM.length) revert BadTier();
        Position[] storage ps = _positions[msg.sender];
        if (ps.length >= MAX_POSITIONS) revert TooManyPositions();

        _updateReward(msg.sender);

        // Measure what actually arrived. A fee-on-transfer stake token would otherwise credit more principal
        // than the contract holds, and the shortfall would surface as somebody else's withdrawal reverting.
        uint256 before = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = stakeToken.balanceOf(address(this)) - before;
        if (got == 0) revert Zero();

        // An unchecked downcast here would silently truncate a stake above 2^128 and credit the user a
        // fraction of what they paid in. No real token gets near it, but "no real token" is not a check.
        if (got > type(uint128).max) revert Zero();

        uint32 term = TIER_TERM[tier];
        positionId = ps.length;
        ps.push(Position({
            amount: uint128(got),
            unlockAt: term == 0 ? 0 : uint64(block.timestamp + term),
            mulBps: TIER_MUL_BPS[tier],
            tier: tier
        }));
        stakedOf[msg.sender] += got;
        totalStaked += got;
        if (tier != 0) { committedOf[msg.sender] += got; totalCommitted += got; }

        _resync(msg.sender);
        _kickstartPending();
        emit Staked(msg.sender, positionId, got, tier, ps[positionId].unlockAt);
    }

    /// @notice Close position `positionId` in full.
    ///
    /// Matured (or flexible): principal back in full.
    /// Immature: principal back minus `EARLY_EXIT_BPS`, which goes to the stakers who stayed.
    /// Either way, pending rewards are KEPT — claim them whenever.
    ///
    /// This never reverts for an immature position. Paying to leave early is the whole mechanism; being
    /// unable to leave is not.
    function withdraw(uint256 positionId) external nonReentrant returns (uint256 returned) {
        Position[] storage ps = _positions[msg.sender];
        if (positionId >= ps.length) revert NoPosition();

        _updateReward(msg.sender);

        Position memory p = ps[positionId];
        bool early = p.unlockAt != 0 && block.timestamp < p.unlockAt;

        // Swap-and-pop: order is not meaningful and this keeps the array bounded without a shift. Note it
        // MOVES the last position's id, which is why events carry ids and callers should re-read positionsOf.
        ps[positionId] = ps[ps.length - 1];
        ps.pop();

        uint256 amount = p.amount;
        stakedOf[msg.sender] -= amount;
        totalStaked -= amount;
        if (p.tier != 0) { committedOf[msg.sender] -= amount; totalCommitted -= amount; }

        // The early-exit penalty is the 15% on principal and NOTHING ELSE. Rewards already earned stay
        // earned, matured or not.
        //
        // This used to also forfeit the position's share of pending rewards, and that mechanic did not
        // survive being measured. `claim` never forfeits, so anyone who knew to press Claim before Withdraw
        // banked their rewards and paid only the 15% — a 365-day lock broken on day 30 still came out ahead.
        // The forfeit therefore never touched a sophisticated leaver; it landed exclusively on people who did
        // not know the trick, which is the precise inverse of who a penalty should hit. A rule that only
        // punishes the uninformed is worse than no rule, and it made the contract's own description false.
        //
        // Nothing defensive is lost with it. JIT staking is already dead because every reward STREAMS rather
        // than dropping as a lump, so a flash staker accrues only the sliver that streams during their stay,
        // and the 15% on principal still prices impatience — visibly, and identically for everyone.
        uint256 tax;
        if (early) tax = Math.mulDiv(amount, EARLY_EXIT_BPS, BPS);
        returned = amount - tax;

        _resync(msg.sender);

        // Booked into the pot rather than paid out here — see `_penalise` for the two attacks that
        // an instant payout enabled.
        if (tax > 0) _penalise(address(stakeToken), tax);

        if (returned > 0) stakeToken.safeTransfer(msg.sender, returned);
        emit Withdrawn(msg.sender, positionId, returned, tax, early);
    }

    /// @notice Release parked rewards once the pool has held weight for PENDING_DELAY. Permissionless
    /// and idempotent: it only moves money into the ordinary reward stream, so there is nothing to gain
    /// by calling it and nothing to lose by anyone being able to.
    function releasePending() external nonReentrant {
        _updateReward(address(0));
        _kickstartPending();
    }

    /// @notice Re-check anyone's boost and correct their weight. Permissionless on purpose: a boost that is no
    /// longer deserved has to be removable by somebody, and the person losing it will not do it themselves.
    function syncBoost(address user) external nonReentrant {
        _updateReward(user);
        _resync(user);
        emit BoostSynced(user, boosted[user], weightOf[user]);
    }

    // ─────────────────────────────────────────────────────────────── claim ──

    /// @notice Claim `asset`. Claiming is NOT withdrawing, so it never touches a lock.
    ///
    /// It DOES re-check the boost, and that is not incidental. `weightOf` caches the boost, and since
    /// the boost reads locked principal it lapses the moment a lock MATURES — an event that arrives on
    /// a timer, with no transaction from anyone. `syncBoost` is permissionless, but nobody has a
    /// reason to spend gas correcting a stranger, so without this a staker would keep a boost they
    /// stopped deserving essentially forever, diluting everybody else. Measured: +25% weight retained
    /// indefinitely past maturity.
    ///
    /// Correcting it here means the lapse is enforced at the moment the holder reaches for the money.
    /// It does not claw back what already accrued at the stale weight — that would need a checkpoint
    /// per position — so a boost still over-earns between maturity and the next interaction. It bounds
    /// the window to "until they touch the pool" instead of "forever".
    function claim(address asset) public nonReentrant returns (uint256 amount) {
        _updateReward(msg.sender);
        _resync(msg.sender);
        amount = rewardsAccrued[asset][msg.sender];
        if (amount == 0) return 0;
        rewardsAccrued[asset][msg.sender] = 0;
        _payout(asset, msg.sender, amount);
        emit Claimed(msg.sender, asset, amount);
    }

    function claimMany(address[] calldata assets) external nonReentrant returns (uint256[] memory amounts) {
        _updateReward(msg.sender);
        _resync(msg.sender); // same lapsed-boost correction as `claim` — see the note there

        amounts = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = rewardsAccrued[asset][msg.sender];
            if (amount == 0) continue;
            rewardsAccrued[asset][msg.sender] = 0;
            amounts[i] = amount;
            _payout(asset, msg.sender, amount);
            emit Claimed(msg.sender, asset, amount);
        }
    }

    function _payout(address asset, address to, uint256 amount) internal {
        if (asset == ETH) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    // ────────────────────────────────────────────────────────────── fund ──

    function notifyReward(address asset, uint256 amount) external nonReentrant {
        if (!isRewarder[msg.sender]) revert NotRewarder();
        if (!rewardInfo[asset].listed) revert NotListed();
        if (asset == ETH) revert Zero(); // ETH arrives through notifyRewardETH
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        _fund(asset, IERC20(asset).balanceOf(address(this)) - before);
    }

    function notifyRewardETH() external payable nonReentrant {
        if (!isRewarder[msg.sender]) revert NotRewarder();
        _fund(ETH, msg.value);
    }

    function _fund(address asset, uint256 amount) internal {
        if (amount == 0) revert Zero();
        _updateReward(address(0));
        _applyReward(asset, amount, true);
    }

    // ────────────────────────────────────────────────────────── governance ──

    function _listReward(address asset, uint32 duration) internal {
        if (rewardInfo[asset].listed) revert AlreadyListed();
        if (rewardTokens.length >= MAX_REWARD_TOKENS) revert TooManyRewards();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        rewardInfo[asset].listed = true;
        rewardInfo[asset].duration = duration;
        rewardInfo[asset].lastUpdateTime = uint64(block.timestamp);
        rewardTokens.push(asset);
        emit RewardListed(asset, duration);
    }

    function listReward(address asset, uint32 duration) external onlyOwner {
        _listReward(asset, duration);
    }

    /// @notice Change a reward's streaming window. Only between streams, never during one.
    ///
    /// THE GUARD IS THE WHOLE FUNCTION. On its own this setter looks harmless — it does not touch a
    /// running rate. But the NEXT deposit of any size, one wei included, re-spreads the entire
    /// un-streamed backlog over the new window, so shrinking the window compresses everything already
    /// owed into it. Measured: a 365-day, 1,000,000-token stream cut to one hour by a 1-wei top-up,
    /// after which one hour of free flexible weight took 987,112 of it. The same whale over the same
    /// hour without the duration change takes 113 — roughly 8,700x, from one config flip, and the
    /// honest version needs no attacker at all. Synthetix guards this setter for exactly this reason.
    function setRewardDuration(address asset, uint32 duration) external onlyOwner {
        RewardInfo storage r = rewardInfo[asset];
        if (!r.listed) revert NotListed();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        if (block.timestamp <= r.periodFinish) revert StreamRunning(r.periodFinish);
        r.duration = duration;
    }

    /// @notice Sweep the pot to `strandedSink`.
    ///
    /// THE POT USED TO BE HANDED BACK TO STAKERS, AND THAT IDEA HAS NOW FAILED THREE TIMES, each time
    /// wearing a different disguise. Measured on the version this replaces:
    ///
    ///   • The person who PAID the penalty re-staked flexible — no lock, no exit fee — and collected it
    ///     straight back. A solo staker breaking a 365-day lock paid 0.0000000000005 tokens against an
    ///     advertised 150,000. The fee was not reduced, it was deleted.
    ///   • A whale who never staked front-ran the release with free flexible weight and took 136,363 of
    ///     a 150,000 pot, leaving the honest locked stakers it belonged to with the remainder.
    ///
    /// The root is identical every time: anything shared out by CURRENT weight can be taken by weight
    /// that costs nothing to acquire and nothing to abandon. Excluding one address failed to a second
    /// wallet. Paying instantly failed to a sandwich. Streaming failed to a front-run.
    ///
    /// It is not worth a fourth attempt, because it is now the SMALL fuel source. Every coin's pool is
    /// fed 0.25% of its own sell volume and $ROBIN stakers are fed 0.25% of every buy on the pad —
    /// continuous, far larger, and with no distribution mechanic to game. So an early exit still costs
    /// 15%, that 15% still leaves the leaver for good, and it now goes somewhere nobody can race for.
    /// `strandedAll` keeps the pot visible either way.
    function sweepStranded(address asset) external nonReentrant returns (uint256 amount) {
        amount = stranded[asset];
        if (amount == 0) revert NothingStranded();
        address to = strandedSink;
        if (to == address(0)) revert Zero();
        stranded[asset] = 0;
        _payout(asset, to, amount);
        emit StrandedSwept(asset, to, amount);
    }

    function setStrandedSink(address sink) external onlyOwner {
        if (sink == address(0)) revert Zero();
        strandedSink = sink;
        emit StrandedSinkChanged(sink);
    }


    function setRewarder(address who, bool allowed) external onlyOwner {
        isRewarder[who] = allowed;
    }

    /// @notice Retune the holder boost. The multiplier is capped by `MAX_BOOST_BPS`, which the owner cannot
    /// raise — so this can adjust the boost but can never turn it into a device that starves everyone else.
    ///
    /// Existing stakers keep their cached weight until they next touch the pool (stake, withdraw or claim
    /// all resync them) or somebody calls `syncBoost` on them. Nothing is applied retroactively to rewards
    /// already earned. A staker who never interacts therefore carries a stale weight indefinitely; that is
    /// the same residual described on `claim`, and the reason `syncBoost` is permissionless.
    function setBoost(address source, uint256 threshold, uint16 bps) external onlyOwner {
        if (bps > MAX_BOOST_BPS) revert BadBoost();
        boostSource = IBoostSource(source);
        boostThreshold = threshold;
        boostBps = bps;
        emit BoostChanged(source, threshold, bps);
    }

    /// @notice Tune the whale cap. `bps_` of 0 removes it entirely.
    ///
    /// Lowering it below what a big staker already holds does not touch their principal — it lowers what
    /// their next `_resync` will count, so they earn less from that point on and withdraw in full whenever
    /// they like. It cannot be used to trap anyone.
    function setCap(uint32 bps_, uint256 step_, uint32 stepBps_, uint32 maxBps_) external onlyOwner {
        // Anything under 100% of everyone else's weight starts clipping ordinary stakers rather than
        // whales, and the natural response to that is to split your own stake across wallets — the exact
        // behaviour this is meant to discourage. Guarded so a future owner cannot make the pool hostile,
        // by accident or otherwise.
        if (bps_ != 0 && bps_ < 10_000) revert BadCap();
        if (uint256(bps_) + uint256(maxBps_) > MAX_CAP_TOTAL_BPS) revert BadCap();
        capBps = bps_;
        capStep = step_;
        capStepBps = stepBps_;
        capMaxBps = maxBps_;
        emit CapSet(bps_, step_, stepBps_, maxBps_);
    }

    receive() external payable {
        // Plain transfers are treated as an ETH reward from a rewarder, and refused from anyone else so a
        // stray send cannot silently become an unaccounted balance.
        if (!isRewarder[msg.sender]) revert NotRewarder();
        _fund(ETH, msg.value);
    }
}
