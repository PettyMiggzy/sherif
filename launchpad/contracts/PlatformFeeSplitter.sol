// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PlatformFeeSplitter — the dormant $ROBIN seam on the PLATFORM fee leg only
/// @notice Built now, does nothing yet. It sits (optionally) in front of the 1% platform buy leg so that,
/// when $ROBIN + staking ship later, a configurable share of PLATFORM-WIDE fees can be diverted to a $ROBIN
/// distributor as ETH — without touching any per-coin logic and without a contract migration.
///
/// It never sees the per-coin RewardVault (the two 0.25% trader/holder legs) nor the creator sell leg. With
/// `robinShareBps = 0` (the shipping default) it forwards 100% to the platform treasury and behaves exactly
/// like paying the treasury directly. Staking mechanics are deliberately deferred — only this seam is built.
contract PlatformFeeSplitter is Ownable2Step {
    uint16 public robinShareBps; // ships = 0 (no diversion)
    address public robinSink; // ships = 0; later a platform-aggregate $ROBIN distributor
    address public platformTreasury; // the platform's existing sink

    error ZeroAddr();
    error BadBps();
    error PayFail();

    event Routed(uint256 total, uint256 toRobin, uint256 toTreasury);
    event RobinShareSet(uint16 bps);
    event RobinSinkSet(address sink);
    event TreasurySet(address treasury);

    constructor(address platformTreasury_, address owner_) Ownable(owner_) {
        if (platformTreasury_ == address(0)) revert ZeroAddr();
        platformTreasury = platformTreasury_;
    }

    /// @notice Route an incoming platform-fee payment. Dormant-safe: with share 0 or sink unset, 100% goes to
    /// treasury and it never reverts on an unset sink.
    function route() public payable {
        uint256 total = msg.value;
        uint256 toRobin;
        uint256 bps = robinShareBps;
        address sink = robinSink;
        if (bps > 0 && sink != address(0)) {
            toRobin = (total * bps) / 10_000;
            if (toRobin > 0) {
                (bool r,) = sink.call{value: toRobin}("");
                if (!r) revert PayFail();
            }
        }
        uint256 toTreasury = total - toRobin;
        if (toTreasury > 0) {
            (bool ok,) = platformTreasury.call{value: toTreasury}("");
            if (!ok) revert PayFail();
        }
        emit Routed(total, toRobin, toTreasury);
    }

    receive() external payable {
        route();
    }

    function setRobinShareBps(uint16 bps) external onlyOwner {
        if (bps > 10_000) revert BadBps();
        robinShareBps = bps;
        emit RobinShareSet(bps);
    }

    function setRobinSink(address sink) external onlyOwner {
        robinSink = sink; // may be zero (disables diversion)
        emit RobinSinkSet(sink);
    }

    function setPlatformTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddr();
        platformTreasury = t;
        emit TreasurySet(t);
    }
}
