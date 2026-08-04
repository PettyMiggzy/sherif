// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IDisperse {
    function disperseEther(address[] calldata r, uint256[] calldata v) external payable;
}

/// Malicious ETH recipient: on receiving ETH it tries to re-enter disperseEther.
/// The ReentrancyGuard must make that inner call revert; we record that it did.
contract ReenterEther {
    IDisperse public immutable target;
    bool public tried;
    bool public reentryReverted;

    constructor(address t) { target = IDisperse(t); }

    receive() external payable {
        if (!tried) {
            tried = true;
            address[] memory r = new address[](1);
            uint256[] memory v = new uint256[](1);
            r[0] = address(this);
            v[0] = 0;
            try target.disperseEther{value: 0}(r, v) {
                // reached only if the guard DIDN'T stop reentry
            } catch {
                reentryReverted = true;
            }
        }
    }
}

/// Fee-on-transfer ERC20 (1% burned on every user-to-user transfer). Used to show
/// disperseTokenDirect stays safe while the pull-based disperseToken does not.
contract FeeERC20 is ERC20 {
    constructor(uint256 supply) ERC20("Fee Token", "FEE") { _mint(msg.sender, supply); }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value >= 100) {
            uint256 fee = value / 100; // 1%
            super._update(from, address(0xdEaD), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
