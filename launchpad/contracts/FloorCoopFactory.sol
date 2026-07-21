// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FloorCoop} from "./FloorCoop.sol";

/// @title FloorCoopFactory — one locked-LP staking vault per token, created on demand
/// @notice Permissionless: anyone can spin up the vault for ANY token that has a live WETH v3 pool (pad coin
/// or not). One vault per token; created once. All vaults route their protocol cut to the same treasury.
contract FloorCoopFactory {
    address public immutable WETH;
    address public immutable v3Factory;
    address public treasury;
    address public owner;
    mapping(address => address) public coopOf; // token => FloorCoop
    address[] public allCoops;

    error Exists();
    error NotOwner();

    event CoopCreated(address indexed token, address coop);
    event TreasurySet(address treasury);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor(address weth_, address v3Factory_, address treasury_) {
        require(weth_ != address(0) && v3Factory_ != address(0) && treasury_ != address(0), "zero");
        WETH = weth_;
        v3Factory = v3Factory_;
        treasury = treasury_;
        owner = msg.sender;
    }

    /// @notice Point future *and* existing vaults' protocol cut at a new treasury (vaults read it live).
    function setTreasury(address t) external {
        if (msg.sender != owner) revert NotOwner();
        require(t != address(0), "zero");
        treasury = t;
        emit TreasurySet(t);
    }

    /// One-step ownership handoff. Used at deploy to hand the factory to the platform admin wallet WITHOUT that
    /// wallet needing to sign an accept — so it can stay cold. The only owner power here is setTreasury; the
    /// factory custodies no funds itself. Guarded against the zero address so ownership can't be burned by mistake.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        require(newOwner != address(0), "zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function createCoop(address token) external returns (address coop) {
        if (coopOf[token] != address(0)) revert Exists();
        coop = address(new FloorCoop(token, WETH, v3Factory, address(this))); // vault reads treasury from us; reverts inside if no pool is live yet
        coopOf[token] = coop;
        allCoops.push(coop);
        emit CoopCreated(token, coop);
    }

    function coopCount() external view returns (uint256) {
        return allCoops.length;
    }
}
