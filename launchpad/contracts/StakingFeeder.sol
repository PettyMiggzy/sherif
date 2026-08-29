// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPoolRegistry {
    function poolOf(address stakeToken) external view returns (address);
}

interface ITierPool {
    function stakeToken() external view returns (address);
    function notifyReward(address asset, uint256 amount) external;
    function notifyRewardETH() external payable;
    function isRewarder(address who) external view returns (bool);
}

/// @title StakingFeeder — the fuel line that keeps coin staking pools paying without the creator
/// @notice A staking pool with nothing in it pays nothing, and a design that asks every coin's
/// creator to remember to top theirs up is a design where almost none of them do. This holds
/// platform revenue and pushes it into the pools, so a staker's rewards do not depend on a founder's
/// goodwill or attention.
///
/// THE ONE PROPERTY THAT MATTERS: MONEY IN HERE CANNOT REACH A WALLET. Every payout path resolves
/// the destination through the pool REGISTRY — `factory.poolOf(pool.stakeToken()) == pool` — so the
/// only addresses this contract can pay are pools the factory itself created. There is no
/// `withdraw`, no `sweep`, no owner escape hatch, and no address parameter anywhere that a caller
/// controls. An operator key stolen off a keeper box can decide WHICH POOL and HOW MUCH; it can
/// never decide WHO, because "who" is not an input.
///
/// That is deliberate and it is the difference between a fee router and a treasury. A treasury with
/// an owner withdrawal is a promise; this is a pipe.
contract StakingFeeder is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The registry every destination is checked against. Changing it changes which pools
    /// can be funded — never whether a wallet can be.
    IPoolRegistry public registry;

    mapping(address => bool) public isOperator;

    uint256 public totalFedEth;
    mapping(address => uint256) public totalFedToken;

    error Zero();
    error NotOperator();
    error NotAPool(address given);
    error NotARewarder(address pool);
    error Insufficient(uint256 have, uint256 need);
    error LengthMismatch();

    event Fed(address indexed pool, address indexed asset, uint256 amount);
    event OperatorSet(address indexed who, bool allowed);
    event RegistrySet(address indexed registry);
    event Received(address indexed from, uint256 amount);

    constructor(address owner_, address registry_) Ownable(owner_) {
        if (registry_ == address(0)) revert Zero();
        registry = IPoolRegistry(registry_);
        isOperator[owner_] = true;
        emit RegistrySet(registry_);
    }

    /// @dev Prove `pool` is a real pool by asking the REGISTRY, not the pool. Asking the pool what it
    /// is would let any contract answer "I am a pool for token X"; asking the registry means only
    /// something the factory actually created can be paid.
    function _requirePool(address pool) internal view {
        if (pool == address(0)) revert NotAPool(pool);
        // An address with no code has to be rejected HERE, not by the try/catch below. Solidity's
        // try/catch does not catch a failure to DECODE return data, and a call to an EOA succeeds
        // with empty returndata — so `try ITierPool(pool).stakeToken()` on a plain wallet reverts
        // with no reason at all rather than landing in the catch. Passing a wallet by mistake would
        // then look like an unexplained failure instead of "that is not a pool".
        if (pool.code.length == 0) revert NotAPool(pool);
        address stakeToken;
        try ITierPool(pool).stakeToken() returns (address t) { stakeToken = t; }
        catch { revert NotAPool(pool); }
        if (registry.poolOf(stakeToken) != pool) revert NotAPool(pool);
        // Checked up front so the failure is a named error rather than a revert from deep inside the
        // pool, which is the difference between "add the feeder as a rewarder" and "it broke".
        if (!ITierPool(pool).isRewarder(address(this))) revert NotARewarder(pool);
    }

    /// @notice Push `amount` of ETH into `pool` as a streamed reward.
    function feedEth(address pool, uint256 amount) public nonReentrant {
        if (!isOperator[msg.sender]) revert NotOperator();
        if (amount == 0) revert Zero();
        if (address(this).balance < amount) revert Insufficient(address(this).balance, amount);
        _requirePool(pool);
        totalFedEth += amount;
        ITierPool(pool).notifyRewardETH{value: amount}();
        emit Fed(pool, address(0), amount);
    }

    /// @notice Push `amount` of an ERC-20 into `pool`. The asset must already be listed there.
    function feedToken(address pool, address asset, uint256 amount) public nonReentrant {
        if (!isOperator[msg.sender]) revert NotOperator();
        _feedToken(pool, asset, amount);
    }

    /// @notice Return a pool's early-exit tax to the stakers of THAT pool. Anyone may call it.
    ///
    /// When someone breaks a lock early they pay 15%, denominated in the staked token, and that tax is
    /// swept here. This sends it home. It is permissionless on purpose — the tax belongs to that pool's
    /// stakers, so it must not need our keeper to be alive to reach them.
    ///
    /// Permissionless is only safe because the destination is not a parameter and the asset is not one
    /// either: both are read off the pool. The asset is `pool.stakeToken()`, so a caller can only ever
    /// move a coin to the single pool that coin belongs to. That matters — the fee revenue this contract
    /// holds is ETH, pooled across every coin on the pad, and an open call that could move ETH would let
    /// a stranger dump the whole pad's fees into one pool of their choosing. ETH is therefore not
    /// reachable from here at all; it goes out only through the operator-gated `feedEth`.
    ///
    /// A coin arrives in this contract from exactly one place — its own pool's `sweepStranded` — so
    /// "the balance of that coin" and "that pool's tax" are the same number. Anyone donating more of it
    /// is donating to that coin's stakers, which is the same thing this call does.
    function returnTax(address pool) external nonReentrant returns (address asset, uint256 amount) {
        _requirePool(pool);
        asset = ITierPool(pool).stakeToken();
        amount = IERC20(asset).balanceOf(address(this));
        if (amount == 0) revert Zero();
        _feedToken(pool, asset, amount);
    }

    function _feedToken(address pool, address asset, uint256 amount) internal {
        if (amount == 0 || asset == address(0)) revert Zero();
        _requirePool(pool);
        IERC20 t = IERC20(asset);
        uint256 held = t.balanceOf(address(this));
        if (held < amount) revert Insufficient(held, amount);
        totalFedToken[asset] += amount;
        // Reset-then-approve: a pool that did not consume a previous allowance would otherwise make
        // the next approve revert on tokens that refuse a non-zero-to-non-zero change.
        t.forceApprove(pool, 0);
        t.forceApprove(pool, amount);
        ITierPool(pool).notifyReward(asset, amount);
        t.forceApprove(pool, 0);
        emit Fed(pool, asset, amount);
    }

    /// @notice Feed many pools in one transaction — how a keeper distributes a batch of fees in
    /// proportion to what each coin actually earned.
    function feedManyEth(address[] calldata pools, uint256[] calldata amounts) external {
        if (pools.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < pools.length; ++i) feedEth(pools[i], amounts[i]);
    }

    // ─────────────────────────────────────────────────────────── governance ──

    function setOperator(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert Zero();
        isOperator[who] = allowed;
        emit OperatorSet(who, allowed);
    }

    /// @notice Repoint the registry — for example when a second-generation factory ships. It changes
    /// WHICH pools are fundable and can never make a wallet fundable.
    function setRegistry(address registry_) external onlyOwner {
        if (registry_ == address(0)) revert Zero();
        registry = IPoolRegistry(registry_);
        emit RegistrySet(registry_);
    }

    /// @notice Anyone may top the fuel line up: the platform's fee wallet, the creator if they want
    /// to, or a supporter. There is no path back out to a wallet, so a donation here is a donation
    /// to that chain's stakers and nothing else.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
