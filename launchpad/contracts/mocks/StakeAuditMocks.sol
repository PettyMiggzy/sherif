// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev A reward token that can be switched to revert on transfer — a paused/blocklisted stock token.
contract FreezableReward {
    string public name = "Pausable"; string public symbol = "PAUSE"; uint8 public decimals = 18;
    uint256 public totalSupply;
    bool public frozen;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(uint256 s) { totalSupply = s; balanceOf[msg.sender] = s; }
    function setFrozen(bool f) external { frozen = f; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) public returns (bool) {
        require(!frozen, "frozen");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(!frozen, "frozen");
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// @dev Takes a 1% cut on every transfer. The stake path must credit what ARRIVED, not what was asked for.
contract FotStakeToken {
    string public name = "Fee"; string public symbol = "FEE"; uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(uint256 s) { totalSupply = s; balanceOf[msg.sender] = s; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function _move(address f, address to, uint256 a) internal {
        uint256 fee = a / 100;
        balanceOf[f] -= a; balanceOf[to] += a - fee; balanceOf[address(0xdead)] += fee;
    }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        _move(f, to, a); return true;
    }
}

/// @dev Refuses ETH, so the native-reward payout failure path is reachable.
contract StakeEthRejecter {
    function stakeInto(address pool, address token, uint256 amount) external {
        IERC20(token).approve(pool, amount);
        (bool ok,) = pool.call(abi.encodeWithSignature("stake(uint256,uint8)", amount, uint8(0)));
        require(ok, "stake");
    }
    function claimFrom(address pool, address asset) external {
        (bool ok, bytes memory r) = pool.call(abi.encodeWithSignature("claim(address)", asset));
        if (!ok) { assembly { revert(add(r, 0x20), mload(r)) } }
    }
    receive() external payable { revert("no eth"); }
}

/// @dev Does the whole flash-boost in ONE transaction: stake borrowed $ROBIN in the boost-source
/// pool, sync the boost on a satellite pool, then unstake. Proves whether the boost survives.
contract FlashBoost {
    function run(address flagship, address satellite, address robin, uint256 amount) external {
        IERC20(robin).approve(flagship, amount);
        (bool ok,) = flagship.call(abi.encodeWithSignature("stake(uint256,uint8)", amount, uint8(0)));
        require(ok, "stake");
        (ok,) = satellite.call(abi.encodeWithSignature("syncBoost(address)", address(this)));
        require(ok, "sync");
        (ok,) = flagship.call(abi.encodeWithSignature("withdraw(uint256)", uint256(0)));
        require(ok, "exit");
        IERC20(robin).transfer(msg.sender, IERC20(robin).balanceOf(address(this)));
    }
    function stakeIn(address pool, address token, uint256 amount, uint8 tier) external {
        IERC20(token).approve(pool, amount);
        (bool ok,) = pool.call(abi.encodeWithSignature("stake(uint256,uint8)", amount, tier));
        require(ok, "stake");
    }
}
