// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST-ONLY settable boost oracle. Returns a per-(side,user) bps multiplier; DualStaking
/// clamps it to [10000, 40000] and try/catches it, so this can return anything (incl. reverting).
contract MockBoostOracle {
    mapping(uint8 => mapping(address => uint256)) public bps;
    bool public shouldRevert;

    function set(uint8 side, address user, uint256 b) external {
        bps[side][user] = b;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function boostBps(uint8 side, address user) external view returns (uint256) {
        require(!shouldRevert, "oracle down");
        uint256 b = bps[side][user];
        return b == 0 ? 10000 : b;
    }
}
