// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DualStaking} from "./DualStaking.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title StakingFactory
/// @notice One call spins up a `DualStaking` pool for ANY ERC20 — every existing Robin coin can get a
/// stake-to-earn pool, not just V4 pads. Bakes in the platform economics at deploy time:
///   • the platform claim fee (default 5%) routed to the platform treasury
///   • no lock by default (antiJitDelay 0) — JIT is handled by streaming + forfeit-to-stayers
/// Pass `stock == address(0)` for a plain single-book pool (just stake the coin, earn rewards); pass a
/// real stock for the two-book "earn the other" pad. Ownership is handed to the platform multisig
/// (Ownable2Step → it calls `acceptOwnership()` on the new pool to finalize).
contract StakingFactory {
    address public immutable platformTreasury; // where every pool's claim fee is paid
    address public immutable platformOwner; // final owner of every pool (multisig)
    uint16 public immutable defaultClaimFeeBps; // e.g. 500 = 5%

    mapping(address token => address[]) public poolsOf;
    address[] public allPools;

    event StakingPoolCreated(
        address indexed token, address indexed stock, address indexed pool, uint32 antiJitDelay, uint16 claimFeeBps
    );

    error Zero();
    error FeeTooHigh();

    constructor(address platformTreasury_, address platformOwner_, uint16 defaultClaimFeeBps_) {
        if (platformTreasury_ == address(0) || platformOwner_ == address(0)) revert Zero();
        if (defaultClaimFeeBps_ > 1_000) revert FeeTooHigh(); // 10% ceiling, matches DualStaking
        platformTreasury = platformTreasury_;
        platformOwner = platformOwner_;
        defaultClaimFeeBps = defaultClaimFeeBps_;
    }

    /// @notice Deploy a staking pool for `token` (optionally paired with `stock`).
    /// @param token the ERC20 people stake (the coin)
    /// @param stock optional paired stock for a two-book pool; address(0) => single-book
    /// @param antiJitDelay unstake hold in seconds (0 = no lock, the default)
    /// @param extraRewarder optional extra address allowed to fund rewards (e.g. the coin's creator)
    function createPool(address token, address stock, uint32 antiJitDelay, address extraRewarder)
        external
        returns (address pool)
    {
        if (token == address(0)) revert Zero();
        // Factory is the temporary owner so it can configure, then hands off to the platform multisig.
        DualStaking ds = new DualStaking(token, stock, address(this), antiJitDelay, address(0), PoolId.wrap(bytes32(0)), 0);
        ds.setPlatformTreasury(platformTreasury);
        ds.setPlatformClaimFee(defaultClaimFeeBps);
        ds.setRewarder(platformOwner, true); // platform can fund rewards (e.g. from LP sell-side fees)
        if (extraRewarder != address(0)) ds.setRewarder(extraRewarder, true);
        ds.transferOwnership(platformOwner); // Ownable2Step: platformOwner must acceptOwnership()

        pool = address(ds);
        poolsOf[token].push(pool);
        allPools.push(pool);
        emit StakingPoolCreated(token, stock, pool, antiJitDelay, defaultClaimFeeBps);
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    function poolsOfLength(address token) external view returns (uint256) {
        return poolsOf[token].length;
    }
}
