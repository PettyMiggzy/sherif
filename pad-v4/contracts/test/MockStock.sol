// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST-ONLY stand-in for a Robinhood Stock Token registry (blocklist + global pause).
contract MockStockRegistry {
    bool public paused;
    mapping(address => bool) public isBlocked;
    mapping(address => bool) public isRegistered; // [H-2] which stocks THIS registry actually governs

    function setPaused(bool v) external {
        paused = v;
    }

    function setBlocked(address a, bool v) external {
        isBlocked[a] = v;
    }

    function setRegistered(address stock, bool v) external {
        isRegistered[stock] = v;
    }
}

/// @notice TEST-ONLY stand-in for a Robinhood Stock Token: an 18-dec ERC20 plus the stock getters the
/// StockQuoteAdapter reads (uiMultiplier / newUIMultiplier / effectiveAt / oraclePaused / paused /
/// ACCESS_CONTROLLED_REGISTRY). All settable so tests can drive corporate actions, pauses, and the
/// "getter reverts" path (via `breakGetters`).
contract MockStock is ERC20 {
    address public immutable ACCESS_CONTROLLED_REGISTRY;
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier;
    uint256 public effectiveAt;
    bool public oraclePaused;
    bool private _paused;
    bool public breakGetters; // when true, paused() reverts to exercise the adapter's try/catch

    constructor(address registry_, uint256 supply) ERC20("Mock Stock", "mNVDA") {
        ACCESS_CONTROLLED_REGISTRY = registry_;
        _mint(msg.sender, supply);
    }

    /// @dev A real function (not an auto-getter) so `breakGetters` can make it revert.
    function paused() external view returns (bool) {
        require(!breakGetters, "getter down");
        return _paused;
    }

    function setPaused(bool v) external {
        _paused = v;
    }

    function setOraclePaused(bool v) external {
        oraclePaused = v;
    }

    function setBreakGetters(bool v) external {
        breakGetters = v;
    }

    function scheduleMultiplier(uint256 nm, uint256 ea) external {
        newUIMultiplier = nm;
        effectiveAt = ea;
    }

    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }
}
