// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal mocks for RobinZap tests: an ERC20 coin, a WETH9-style wrapper, and a
// PadRouter stand-in whose buy() mirrors the real one (credits coins to msg.sender,
// reverts on slippage, and can refund over-ceiling ETH).

contract MockCoin {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function mintTo(address to) external payable { balanceOf[to] += msg.value; } // fund + credit in one step
    function withdraw(uint256 amt) external {
        balanceOf[msg.sender] -= amt;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "weth send");
    }
    receive() external payable {}
}

contract MockPadRouter {
    MockCoin public coin;
    uint256 public rate;      // coins minted per wei of ETH
    uint256 public refundWei; // ETH refunded to the buyer each call (over-ceiling sim)
    bool public failNext;

    constructor(MockCoin _coin, uint256 _rate) { coin = _coin; rate = _rate; }
    function setRefund(uint256 w) external { refundWei = w; }
    function setFail(bool f) external { failNext = f; }

    function buy(address, uint256 minOut) external payable returns (uint256 tokensOut) {
        require(!failNext, "router forced fail");
        tokensOut = msg.value * rate;
        require(tokensOut >= minOut, "Slippage");
        coin.mint(msg.sender, tokensOut);
        if (refundWei > 0) {
            (bool ok, ) = msg.sender.call{value: refundWei}("");
            require(ok, "refund");
        }
    }

    receive() external payable {}
}
