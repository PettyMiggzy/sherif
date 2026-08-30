// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal stand-in for the owner-governed swap-split source, so a test can turn the v2 branch ON.
contract MockSwapSplit {
    uint256 public p; uint256 public c; uint256 public f;
    constructor(uint256 p_, uint256 c_, uint256 f_) { p = p_; c = c_; f = f_; }
    function swapSplit() external view returns (uint256, uint256, uint256) { return (p, c, f); }
}
