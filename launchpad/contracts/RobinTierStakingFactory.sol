// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RobinTierStaking} from "./RobinTierStaking.sol";

/// @title RobinTierStakingFactory — one tiered staking pool per token, created on demand
/// @notice A launchpad grows a pool at a time. Hardcoding a single staking address into the site works
/// exactly once; every coin launched afterwards has nowhere to stake. This is the registry that makes the
/// staking page a list rather than a constant: `createPool` mints a pool for a token, `poolOf` resolves it,
/// and `allPools` enumerates them so a front end can render every pool that exists without being redeployed.
///
/// THE BOOST HAS TO BE WIRED HERE, NOT AFTERWARDS. Every pool reads the same $ROBIN position to decide who is
/// boosted, and a pool created with the wrong source (or none) silently gives nobody a boost — the failure is
/// invisible, because an unboosted pool works perfectly. So the factory holds the canonical source and stamps
/// it into every pool it creates. The one pool that cannot be handled that way is the flagship $ROBIN pool
/// itself, which must point at ITSELF: a contract cannot know its own address before it exists, so the
/// factory sets it immediately after deployment, in the same transaction.
///
/// WHO MAY CREATE. Creation is allowlisted rather than open, and the reason is the front end: `allPools` is
/// what the staking page renders, so an open factory is an open listing, and anyone could mint a pool for a
/// token they control and have it appear next to the real ones. The allowlist is deliberately not just the
/// owner — the pad's own automation (a keeper, or the graduation path) is meant to hold a slot and create
/// pools without a human, which is the entire point of a registry. `setOpenCreation` exists for the day that
/// tradeoff is worth revisiting, and is off.
contract RobinTierStakingFactory is Ownable {
    /// @notice The $ROBIN pool every other pool reads staked balances from for the holder boost.
    address public boostSource;
    /// @notice The StakingFeeder, authorised as a rewarder on every pool this factory creates.
    ///
    /// WITHOUT THIS, NOTHING EVER REACHES A POOL. The feeder funds a pool by calling `notifyReward`,
    /// which only a rewarder may do — so a pool created without it is a pool the fee pipeline cannot
    /// pay, and the failure is silent: fees accrue, the keeper's call reverts, and the stakers simply
    /// never see anything. Wiring it at creation is what makes "every coin's pool fills itself" true
    /// rather than a per-pool chore somebody has to remember.
    address public feeder;

    mapping(address => address) public poolOf; // stake token => pool (0 if none)
    address[] public allPools;
    mapping(address => bool) public isCreator;
    bool public openCreation;

    error Zero();
    error PoolExists(address pool);
    error NotCreator();

    event PoolCreated(address indexed stakeToken, address indexed pool, uint256 index);
    event BoostSourceChanged(address indexed source);
    event FeederSet(address indexed feeder);
    event CreatorSet(address indexed who, bool allowed);
    event OpenCreationSet(bool open);

    constructor(address owner_) Ownable(owner_) {
        isCreator[owner_] = true;
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    /// @notice Every pool, for a front end that wants to render the list in one read.
    function pools() external view returns (address[] memory) {
        return allPools;
    }

    /// @notice Create the pool for `stakeToken`. Reverts if one already exists — `poolOf` is the single
    /// answer to "where do I stake this", and two pools for one token splits the rewards and the stakers.
    ///
    /// `selfBoost` makes the new pool its own boost source. That is for the flagship $ROBIN pool and nothing
    /// else: on any other token it would mean "staking this coin boosts this coin", which is not the boost
    /// the site describes and would let a worthless token mint its own multiplier.
    function createPool(address stakeToken, bool selfBoost) external returns (address pool) {
        if (!openCreation && !isCreator[msg.sender] && msg.sender != owner()) revert NotCreator();
        // `selfBoost` writes the FACTORY-WIDE boost source, which every pool created afterwards
        // inherits. A creator slot is meant to be a low-value automation key — the keeper holds one and
        // uses it on every graduation — so letting it set this would let a stolen keeper key point the
        // boost oracle at a token it mints for free and hand itself +25% weight in every future pool.
        // The comment in poolmaker.js promising that key "cannot change the boost" is only true with
        // this line present.
        if (selfBoost && msg.sender != owner()) revert NotCreator();
        if (stakeToken == address(0)) revert Zero();
        address existing = poolOf[stakeToken];
        if (existing != address(0)) revert PoolExists(existing);

        // The pool is born owned by THIS FACTORY, wired, and only then handed over. It cannot be constructed
        // owned by the final owner: every setter on the pool is `onlyOwner`, so the factory would be unable to
        // configure the thing it just deployed and `setBoost` below would revert. Nothing observes the pool
        // between construction and handover — it is one transaction — so the temporary ownership is not a
        // window anyone can act in.
        address o = owner();
        RobinTierStaking p = new RobinTierStaking(stakeToken, address(this), selfBoost ? address(0) : boostSource);
        pool = address(p);

        if (selfBoost) {
            // The flagship case. It could not be passed to the constructor because the address did not exist
            // yet, so it is set here — same transaction, so the pool is never live with no source.
            p.setBoost(pool, p.boostThreshold(), p.boostBps());
            boostSource = pool;
            emit BoostSourceChanged(pool);
        }

        // The constructor made the DEPLOYER a rewarder, and the deployer is this factory. Left alone, the
        // factory could fund pools forever while the actual owner could not fund any of them — the exact
        // inverse of the intent. Hand the role over and drop our own.
        p.setRewarder(o, true);
        // Authorised here, while this factory still owns the pool — afterwards only `o` could do it.
        if (feeder != address(0)) p.setRewarder(feeder, true);
        p.setRewarder(address(this), false);
        p.transferOwnership(o);

        poolOf[stakeToken] = pool;
        allPools.push(pool);
        emit PoolCreated(stakeToken, pool, allPools.length - 1);
    }

    /// @notice Point at the StakingFeeder. Applies to pools created AFTER this — existing pools need
    /// their owner to call `setRewarder(feeder, true)` directly, since the factory no longer owns them.
    function setFeeder(address feeder_) external onlyOwner {
        feeder = feeder_;
        emit FeederSet(feeder_);
    }

    function setBoostSource(address source) external onlyOwner {
        boostSource = source;
        emit BoostSourceChanged(source);
    }

    function setCreator(address who, bool allowed) external onlyOwner {
        isCreator[who] = allowed;
        emit CreatorSet(who, allowed);
    }

    function setOpenCreation(bool open) external onlyOwner {
        openCreation = open;
        emit OpenCreationSet(open);
    }
}
