// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST-ONLY ERC20 that reverts on transfers to/from a blocklisted address — a stand-in for
/// a paused/blocklisting stock token. Used to prove the hook's D2 guarded `take`: when the fee
/// currency blocks the hook, the skim is SKIPPED and the swap still completes (never bricks).
contract BlocklistERC20 is ERC20 {
    mapping(address => bool) public blocked;

    constructor(uint256 supply) ERC20("Blocklist", "BLK") {
        _mint(msg.sender, supply);
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "BLOCKED");
        super._update(from, to, value);
    }
}
