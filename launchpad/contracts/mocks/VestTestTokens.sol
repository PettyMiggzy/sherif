// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IVestRelease {
    function release(uint256 id) external returns (uint256);
}

/// @dev A token whose transfer OUT of the vesting lock re-enters release() — used to prove the
/// ReentrancyGuard blocks a double-release.
contract ReentrantVestToken is ERC20 {
    address public vault;
    uint256 public targetId;
    bool public armed;

    constructor(uint256 supply) ERC20("Reentrant", "RE") {
        _mint(msg.sender, supply);
    }

    function arm(address v, uint256 id) external {
        vault = v;
        targetId = id;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from == vault) {
            armed = false; // once
            IVestRelease(vault).release(targetId); // should revert via nonReentrant, bubbling up
        }
    }
}

/// @dev A fee-on-transfer token (skims feeBps to a sink on every non-mint/burn transfer) — used to prove
/// the vesting lock records the ACTUAL received amount, not the requested amount.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;
    address public constant SINK = address(0x000000000000000000000000000000000000dEaD);

    constructor(uint256 supply, uint256 feeBps_) ERC20("FeeOnT", "FOT") {
        feeBps = feeBps_;
        _mint(msg.sender, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, SINK, fee);
    }
}
