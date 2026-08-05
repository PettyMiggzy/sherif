// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A reward-token stand-in that mimics the Robinhood Stock Token: transfers revert while `paused`,
/// or for a specifically `blocked` address. Used to prove RobinStaking.unstake() can never be bricked by a
/// paused/blocked reward asset, and that single-asset claim isolates the failure.
contract PausableToken is ERC20 {
    bool public paused;
    mapping(address => bool) public blocked;

    constructor(uint256 supply) ERC20("Stock Token", "STK") {
        _mint(msg.sender, supply);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "paused");
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @dev Refuses to receive ETH — used to test that an ETH claim to a hostile contract reverts cleanly
/// (PayFail) without corrupting accounting.
contract EthRejecter {
    RobinStakingLike public immutable s;

    constructor(address s_) {
        s = RobinStakingLike(s_);
    }

    function doStake(address token, uint256 amount) external {
        IERC20Like(token).approve(address(s), amount);
        s.stake(amount);
    }

    function doClaimEth(address eth) external {
        s.claim(eth);
    }

    receive() external payable {
        revert("no eth");
    }
}

interface RobinStakingLike {
    function stake(uint256) external;
    function claim(address) external returns (uint256);
}

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
}
