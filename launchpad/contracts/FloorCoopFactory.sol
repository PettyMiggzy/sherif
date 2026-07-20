// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FloorCoop} from "./FloorCoop.sol";

/// @title FloorCoopFactory — one community floor-vault per coin, created on demand
/// @notice Permissionless: anyone can spin up the FloorCoop for a graduated coin (it only needs a live
/// token/WETH v3 pool, which exists from block one). One vault per token; created once.
contract FloorCoopFactory {
    address public immutable WETH;
    address public immutable v3Factory;
    mapping(address => address) public coopOf; // token => FloorCoop
    address[] public allCoops;

    error Exists();

    event CoopCreated(address indexed token, address coop);

    constructor(address weth_, address v3Factory_) {
        require(weth_ != address(0) && v3Factory_ != address(0), "zero");
        WETH = weth_;
        v3Factory = v3Factory_;
    }

    function createCoop(address token) external returns (address coop) {
        if (coopOf[token] != address(0)) revert Exists();
        coop = address(new FloorCoop(token, WETH, v3Factory)); // reverts inside if the pool isn't live yet
        coopOf[token] = coop;
        allCoops.push(coop);
        emit CoopCreated(token, coop);
    }

    function coopCount() external view returns (uint256) {
        return allCoops.length;
    }
}
