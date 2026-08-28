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
    function stakedOf(address user) external view returns (uint256);
}

/// @title RobinTierStaking — locked-tier, weighted, forfeit-to-stayers staking
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
///      position always succeeds; it costs EARLY_EXIT_BPS of that position's principal, and the share of
///      pending rewards that position was earning — pro-rata by weight, NOT the whole account. That matters:
///      a hard lock that can trap someone's money is the single scariest thing a staking contract can do, and
///      the whole point of the term is to price impatience, not to imprison anyone.
///
///   3. EARLY EXITS PAY THE STAYERS — AND NEVER THEMSELVES. Both the exit tax and the forfeited rewards go to
///      whoever is still staked, with the leaver explicitly excluded even when they hold other positions.
///      Without that exclusion a staker who is most of the pool receives most of their own penalty back, and
///      the 15% quietly stops applying to exactly the holders it matters most for. In the normal case nothing
///      goes to the platform or the owner — there is no path that sends either one to a wallet.
///
///      One case needs handling rather than a claim: a penalty collected when there is NOBODY ELSE STAKED. It
///      cannot go to the stayers because there are none, and parking it for "the next staker" just hands it
///      back to the leaver, who is the next staker. So it accumulates in `stranded` — a visible pot, readable
///      by any front end via `strandedAll` — and the only exit it has is `releaseStranded`, which streams it
///      to stakers. That function takes no address. There is no path, owner-controlled or otherwise, by which
///      a penalty reaches a wallet.
///
///   4. THE $ROBIN HOLDER BOOST. Hold at least `boostThreshold` $ROBIN — STAKED, see below — and every
///      position you hold in this pool earns a further `boostBps` on top of its tier. It applies across every
///      pool, because every pool reads the same source.
///
/// WHY THE BOOST COUNTS *STAKED* $ROBIN AND NOT A WALLET BALANCE. A balance check is measured in one instant,
/// and one instant is buyable: flash-borrow ten million $ROBIN, call the function that snapshots you, repay in
/// the same transaction. The boost would then cost nothing and mean nothing. Staked $ROBIN cannot be borrowed
/// for a block — leaving costs the exit tax and the pending rewards — so the boost is earned by the people
/// actually holding the risk. This is the same reason `syncBoost` is permissionless: anyone may re-check
/// anyone, so a boost that has stopped being deserved can always be removed by somebody.
///
/// JIT (stake right before a reward lands, grab a slice, leave) is defeated the same way the flexible pool
/// defeats it: every reward STREAMS linearly over a window rather than dropping as a lump, so a flash staker
/// accrues only the sliver that streams during their stay, and forfeits even that on an early exit.
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

    /// @notice Penalties collected while there was nobody else staked to pay them to — the pot. See
    /// `_redistribute`. Held here rather than in `pending` because `pending` streams to whoever stakes next,
    /// and on an empty pool that is the person who just paid the penalty.
    ///
    /// It is deliberately readable (`strandedAll`) so a front end can show the pot growing. There is exactly
    /// one way out of it — `releaseStranded`, which streams it to stakers — and no way at all to a wallet.
    mapping(address => uint256) public stranded;

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
    error NobodyStaked();

    event Staked(address indexed user, uint256 indexed positionId, uint256 amount, uint8 tier, uint64 unlockAt);
    event Withdrawn(address indexed user, uint256 indexed positionId, uint256 returned, uint256 tax, bool early);
    event Claimed(address indexed user, address indexed asset, uint256 amount);
    event Forfeited(address indexed user, address indexed asset, uint256 amount);
    event RewardAdded(address indexed asset, uint256 amount, uint64 periodFinish);
    event RewardListed(address indexed asset, uint32 duration);
    event BoostChanged(address indexed source, uint256 threshold, uint16 bps);
    event BoostSynced(address indexed user, bool boosted, uint256 weight);
    event Stranded(address indexed asset, uint256 amount);
    event StrandedReleased(address indexed asset, uint256 amount);

    constructor(address stakeToken_, address owner_, address boostSource_) Ownable(owner_) {
        if (stakeToken_ == address(0)) revert Zero();
        stakeToken = IERC20(stakeToken_);
        isRewarder[owner_] = true;
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
    uint256 private constant BOOST_GAS = 100_000;

    /// @notice Whether `user` currently qualifies for the holder boost, read live from the source.
    function qualifiesForBoost(address user) public view returns (bool) {
        if (address(boostSource) == address(0) || boostBps == 0) return false;
        // Gas-capped as well as static, so a broken or hostile source can cost a staker their boost but never
        // their exit. See BOOST_GAS.
        (bool ok, bytes memory ret) =
            address(boostSource).staticcall{gas: BOOST_GAS}(abi.encodeCall(IBoostSource.stakedOf, (user)));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (uint256)) >= boostThreshold;
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

    /// @notice Unclaimed reward of `user` in `asset` — what `claim` pays, and what an EARLY withdraw forfeits.
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

    /// @dev Start any parked stream now that there is weight to stream to.
    function _kickstartPending() internal {
        if (totalWeight == 0) return;
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
        }
        uint256 total = amount + remaining;
        r.rewardRate = total / r.duration;
        r.lastUpdateTime = uint64(block.timestamp);
        r.periodFinish = uint64(block.timestamp + r.duration);
        emit RewardAdded(asset, amount, r.periodFinish);
    }

    /// @dev Hand `amount` of `asset` straight to the stakers, with no stream and no delay, by bumping the
    /// per-weight accumulator — EXCLUDING `excluded`, who is the person being penalised.
    ///
    /// The exclusion is the whole point and it is not cosmetic. `_resync` only removes the weight of the
    /// position being closed, so a staker with OTHER positions is still in `totalWeight` when their own
    /// penalty is shared out — and receives a slice of it back, proportional to how much of the pool they
    /// are. A whale who is most of the pool would get most of their own exit tax refunded, and for a large
    /// enough holder the 15% penalty tends to nothing. That is not a rounding issue, it is the penalty
    /// quietly not applying to exactly the people it most needs to.
    ///
    /// So the bump is computed over everyone ELSE's weight, and the excluded staker's checkpoint is advanced
    /// past it so they accrue none of it. Forfeited rewards are handed over rather than re-streamed because
    /// the pool already earned them — re-streaming would delay money the stayers are owed right now.
    function _redistribute(address asset, uint256 amount, address excluded) internal {
        if (amount == 0) return;
        RewardInfo storage r = rewardInfo[asset];
        uint256 denom = totalWeight - weightOf[excluded];
        // NOBODY ELSE IS STAKED. Parking this in `pending` was the obvious move and it is wrong: `pending`
        // streams to whoever is staked next, and the person staked next is overwhelmingly the leaver, who
        // still holds their other positions. Measured, a sole staker closing one of two positions got
        // 149.999 of their own 150 penalty back — the 15% silently became 0% for exactly the holder it was
        // written for. With no one to pay, the only choices are refund the leaver, burn it, or bank it; it
        // goes to the sink, which is the only one of the three that is neither a giveaway nor a loss.
        if (denom == 0) {
            unchecked { stranded[asset] += amount; }
            emit Stranded(asset, amount);
            return;
        }
        uint256 bump = Math.mulDiv(amount, ACC, denom);
        r.rewardPerTokenStored += bump;
        // Advance the penalised staker's checkpoint by exactly the bump, so `earned` returns what it did
        // before it — their already-settled balance, and none of their own penalty.
        userRewardPerTokenPaid[asset][excluded] += bump;
    }

    /// @dev Recompute `user`'s weight from their positions and current boost status, and move `totalWeight`
    /// with it. The caller MUST have settled rewards for `user` first, or the change is applied retroactively
    /// to rewards already earned at the old weight.
    function _resync(address user) internal {
        Position[] storage ps = _positions[user];
        bool boost = qualifiesForBoost(user);
        uint256 w;
        for (uint256 i; i < ps.length; ++i) {
            // The multiplier frozen ON THE POSITION, never the current tier table — a position is priced by
            // the deal it was opened under.
            w += Math.mulDiv(ps[i].amount, ps[i].mulBps, BPS);
        }
        if (boost) w += Math.mulDiv(w, boostBps, BPS);
        totalWeight = totalWeight - weightOf[user] + w;
        weightOf[user] = w;
        boosted[user] = boost;
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

        _resync(msg.sender);
        _kickstartPending();
        emit Staked(msg.sender, positionId, got, tier, ps[positionId].unlockAt);
    }

    /// @notice Close position `positionId` in full.
    ///
    /// Matured (or flexible): principal back, and pending rewards are KEPT — claim them whenever.
    /// Immature: principal back minus `EARLY_EXIT_BPS`, and every pending reward is forfeited. Both the tax
    /// and the forfeit go to the stakers who stayed.
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

        uint256 tax;
        uint256 len = rewardTokens.length;
        // The forfeited amounts have to be REMEMBERED across the resync below, not just zeroed. Zeroing them
        // and redistributing only the tax would leave those reward tokens sitting in this contract credited to
        // nobody — earned by the pool, owed to no one, unreachable forever.
        uint256[] memory forfeited = new uint256[](len);
        if (early) {
            tax = Math.mulDiv(amount, EARLY_EXIT_BPS, BPS);
            // Forfeit only the share of pending rewards THIS POSITION was earning, not the whole account.
            //
            // Zeroing everything was the first version and it is a trap: somebody with a matured 365-day
            // position and a small 7-day one would lose every reward the big position had earned all year by
            // closing the small one a day early. The penalty should be proportional to what is being pulled
            // out, and pro-rata by weight is exactly that — the position's share of what it helped earn.
            //
            // Both sides of the ratio are measured UNBOOSTED and summed from the positions themselves, not
            // read from `weightOf`. The boost scales every position in an account by the same factor, so it
            // cancels out of a ratio — but only if both sides carry the SAME factor, and they need not. A
            // `setBoost` that changes `boostBps` leaves `weightOf` on the old rate until somebody calls
            // `syncBoost`, so boosting the numerator at today's rate against a denominator built at
            // yesterday's can push the numerator above the denominator and forfeit the whole account.
            // Summing the raw positions makes the two sides agree by construction.
            uint256 posWeight = Math.mulDiv(p.amount, p.mulBps, BPS);
            uint256 userWeight = posWeight;
            for (uint256 i; i < ps.length; ++i) userWeight += Math.mulDiv(ps[i].amount, ps[i].mulBps, BPS);
            for (uint256 i; i < len; ++i) {
                address asset = rewardTokens[i];
                uint256 owed = rewardsAccrued[asset][msg.sender];
                if (owed == 0) continue;
                uint256 lose = userWeight == 0 ? owed : Math.mulDiv(owed, posWeight, userWeight);
                if (lose > owed) lose = owed; // defensive; posWeight <= userWeight by construction
                if (lose > 0) {
                    forfeited[i] = lose;
                    rewardsAccrued[asset][msg.sender] = owed - lose;
                    emit Forfeited(msg.sender, asset, lose);
                }
            }
        }
        returned = amount - tax;

        _resync(msg.sender);

        // Redistribute AFTER the resync, so the leaver's weight is already out of the denominator and they
        // cannot take a share of their own tax or their own forfeited rewards.
        if (early) {
            for (uint256 i; i < len; ++i) {
                if (forfeited[i] > 0) _redistribute(rewardTokens[i], forfeited[i], msg.sender);
            }
            _redistribute(address(stakeToken), tax, msg.sender);
        }

        if (returned > 0) stakeToken.safeTransfer(msg.sender, returned);
        emit Withdrawn(msg.sender, positionId, returned, tax, early);
    }

    /// @notice Re-check anyone's boost and correct their weight. Permissionless on purpose: a boost that is no
    /// longer deserved has to be removable by somebody, and the person losing it will not do it themselves.
    function syncBoost(address user) external nonReentrant {
        _updateReward(user);
        _resync(user);
        emit BoostSynced(user, boosted[user], weightOf[user]);
    }

    // ─────────────────────────────────────────────────────────────── claim ──

    /// @notice Claim `asset`. Claiming is NOT withdrawing, so it never forfeits and never touches a lock.
    function claim(address asset) public nonReentrant returns (uint256 amount) {
        _updateReward(msg.sender);
        amount = rewardsAccrued[asset][msg.sender];
        if (amount == 0) return 0;
        rewardsAccrued[asset][msg.sender] = 0;
        _payout(asset, msg.sender, amount);
        emit Claimed(msg.sender, asset, amount);
    }

    function claimMany(address[] calldata assets) external nonReentrant returns (uint256[] memory amounts) {
        _updateReward(msg.sender);
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

    function setRewardDuration(address asset, uint32 duration) external onlyOwner {
        if (!rewardInfo[asset].listed) revert NotListed();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        rewardInfo[asset].duration = duration;
    }

    /// @notice Hand the pot to the stakers, as a normal streamed reward. This is the ONLY exit `stranded` has,
    /// and it has no address parameter — there is no version of this call that pays a wallet, the owner's
    /// included. The pot can be released to holders or sit there being counted; those are the two outcomes.
    ///
    /// WHY THIS IS OWNER-GATED RATHER THAN PERMISSIONLESS, WHICH IS THE OBVIOUS THING TO WANT. The pot exists
    /// precisely because the pool was empty, so releasing it while the same lone staker is still the pool
    /// simply refunds them the penalty this was written to stop. Every cheap on-chain test for "the pool is
    /// populated now" is sybil-able: a second wallet staking one wei makes `stakerCount >= 2` true while the
    /// original staker still holds ~100% of the weight and takes ~100% of the release. There is no gas-cheap
    /// predicate that distinguishes a real pool from that, so the gate is a human looking. The owner's
    /// discretion is over TIMING only — they cannot change the destination, because there is no destination
    /// to change.
    function releaseStranded(address asset) external onlyOwner nonReentrant returns (uint256 amount) {
        amount = stranded[asset];
        if (amount == 0) revert NothingStranded();
        // Releasing into an empty pool would park it in `pending`, which is the exact hole this pot exists to
        // plug. Refuse rather than quietly re-strand it.
        if (totalWeight == 0) revert NobodyStaked();
        stranded[asset] = 0;
        _updateReward(address(0));
        _applyReward(asset, amount, true);
        emit StrandedReleased(asset, amount);
    }

    function setRewarder(address who, bool allowed) external onlyOwner {
        isRewarder[who] = allowed;
    }

    /// @notice Retune the holder boost. The multiplier is capped by `MAX_BOOST_BPS`, which the owner cannot
    /// raise — so this can adjust the boost but can never turn it into a device that starves everyone else.
    /// Existing stakers keep their current weight until somebody calls `syncBoost` on them; nothing is applied
    /// retroactively to rewards already earned.
    function setBoost(address source, uint256 threshold, uint16 bps) external onlyOwner {
        if (bps > MAX_BOOST_BPS) revert BadBoost();
        boostSource = IBoostSource(source);
        boostThreshold = threshold;
        boostBps = bps;
        emit BoostChanged(source, threshold, bps);
    }

    receive() external payable {
        // Plain transfers are treated as an ETH reward from a rewarder, and refused from anyone else so a
        // stray send cannot silently become an unaccounted balance.
        if (!isRewarder[msg.sender]) revert NotRewarder();
        _fund(ETH, msg.value);
    }
}
