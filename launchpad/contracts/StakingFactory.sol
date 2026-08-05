// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {RobinStaking} from "./RobinStaking.sol";

/// @title StakingFactory — one RobinStaking pool per launch, curated reward baskets
/// @notice Mirrors the launch/curve factory pattern: every coin (and $ROBIN itself) can get its OWN staking
/// pool, where holders stake the coin and earn a creator-chosen basket — the coin's own emissions, ETH, or
/// real Robinhood Stock Tokens (AAPL / NVDA / SGOV …). "Creator picks 2 stocks" is literally the
/// `rewardAssets` array passed at creation.
///
/// Every pool is deployed OWNED BY THIS FACTORY, so there is a single admin surface (the factory owner — a
/// platform multisig). The factory configures each pool atomically at birth: it lists the reward assets and
/// authorizes the funders (the creator + the platform fee router / ETH→stock converter). Post-hoc changes go
/// through the `onlyOwner` forwarders below. Pools are permissionless to USE; only creation & curation are gated.
contract StakingFactory is Ownable2Step {
    /// @notice Authorized to create pools (the pad launch backend, or the owner). Prevents pool-squatting on
    /// arbitrary tokens by unrelated parties.
    mapping(address => bool) public isLauncher;

    /// @notice The default platform funder added as a rewarder to every pool (fee router / converter).
    address public platformRewarder;

    mapping(address => address) public poolOf; // stakeToken => pool (one canonical pool per stake token)
    address[] public allPools;

    error NotAuthorized();
    error PoolExists();
    error ZeroAddr();
    error LengthMismatch();

    event PoolCreated(address indexed stakeToken, address indexed pool, address indexed creator);
    event LauncherSet(address indexed who, bool allowed);
    event PlatformRewarderSet(address indexed who);

    constructor(address owner_, address platformRewarder_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddr();
        platformRewarder = platformRewarder_; // may be zero at genesis; set once the router is live
        isLauncher[owner_] = true;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner() && !isLauncher[msg.sender]) revert NotAuthorized();
        _;
    }

    /// @notice Deploy a staking pool for `stakeToken` with a curated reward basket, authorizing `creator`
    /// (and the platform rewarder) to fund it. ETH is always an available reward; pass it in `rewardAssets`
    /// (as RobinStaking.ETH) only if you want a non-default streaming window for it.
    /// @param stakeToken   token users stake (a launched coin, or $ROBIN)
    /// @param rewardAssets reward assets to list (ERC-20 stock tokens and/or RobinStaking.ETH)
    /// @param durations    per-asset streaming window (seconds); must match `rewardAssets` length
    /// @param creator      authorized to fund this pool's rewards
    function createPool(
        address stakeToken,
        address[] calldata rewardAssets,
        uint32[] calldata durations,
        address creator
    ) external onlyAuthorized returns (address pool) {
        if (stakeToken == address(0) || creator == address(0)) revert ZeroAddr();
        if (poolOf[stakeToken] != address(0)) revert PoolExists();
        if (rewardAssets.length != durations.length) revert LengthMismatch();

        RobinStaking s = new RobinStaking(stakeToken, address(this));

        address eth = s.ETH();
        for (uint256 i; i < rewardAssets.length; ++i) {
            address asset = rewardAssets[i];
            if (asset == eth) {
                // ETH is pre-listed with a default window at construction; only adjust if a window was given.
                s.setRewardDuration(eth, durations[i]);
            } else {
                s.listReward(asset, durations[i]);
            }
        }

        s.setRewarder(creator, true);
        if (platformRewarder != address(0)) s.setRewarder(platformRewarder, true);

        pool = address(s);
        poolOf[stakeToken] = pool;
        allPools.push(pool);
        emit PoolCreated(stakeToken, pool, creator);
    }

    // ─────────────────────────────────────────────── views ──

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    // ─────────────────────────────── owner forwarders (factory owns every pool) ──

    function addReward(address pool, address asset, uint32 duration) external onlyOwner {
        RobinStaking(payable(pool)).listReward(asset, duration);
    }

    function setPoolRewardDuration(address pool, address asset, uint32 duration) external onlyOwner {
        RobinStaking(payable(pool)).setRewardDuration(asset, duration);
    }

    function setPoolRewarder(address pool, address who, bool allowed) external onlyOwner {
        RobinStaking(payable(pool)).setRewarder(who, allowed);
    }

    // ─────────────────────────────── factory admin ──

    function setLauncher(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert ZeroAddr();
        isLauncher[who] = allowed;
        emit LauncherSet(who, allowed);
    }

    function setPlatformRewarder(address who) external onlyOwner {
        platformRewarder = who; // applied to pools created AFTER this call
        emit PlatformRewarderSet(who);
    }
}
