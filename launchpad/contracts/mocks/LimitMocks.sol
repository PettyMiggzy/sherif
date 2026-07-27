// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// A freely-mintable ERC20 so the mock swap can always pay out and makers can be funded.
contract MintERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

interface IWethMock {
    function deposit() external payable;
    function withdraw(uint256) external;
}

// A stand-in for RobinSwap with a settable ETH<->coin price, so RobinLimit's price/DCA/keeper
// logic can be tested deterministically. buy() takes ETH and pays the coin; sell() pulls the coin
// (via allowance, like the real RobinSwap) and pays ETH. `coinPerEth` is coin (18-dec) per 1 ETH.
contract MockRobinSwapLimit {
    address public immutable weth;
    MintERC20 public immutable coin;
    uint256 public coinPerEth; // e.g. 1000e18 → 1 ETH buys 1000 coin

    constructor(address weth_, MintERC20 coin_, uint256 coinPerEth_) {
        weth = weth_;
        coin = coin_;
        coinPerEth = coinPerEth_;
    }

    function setPrice(uint256 coinPerEth_) external { coinPerEth = coinPerEth_; }

    function buy(address token, uint256 minOut) external payable returns (uint256 tokensOut) {
        require(token == address(coin), "coin");
        tokensOut = (msg.value * coinPerEth) / 1e18;
        require(tokensOut >= minOut, "min");
        coin.mint(msg.sender, tokensOut);
    }

    function sell(address token, uint256 amountIn, uint256 minOutEth) external returns (uint256 ethOut) {
        require(token == address(coin), "coin");
        IERC20(address(coin)).transferFrom(msg.sender, address(this), amountIn);
        ethOut = (amountIn * 1e18) / coinPerEth;
        require(ethOut >= minOutEth, "min");
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "eth");
    }

    receive() external payable {}
}
