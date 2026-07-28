// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// A freely-mintable ERC20 so the mock swap can always pay out and makers can be funded.
contract MintERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

// A mintable ERC20 that skims a fee on every transfer (NOT on mint) — the classic fee-on-transfer
// token, used to prove RobinLimit enforces minOut on what the maker ACTUALLY receives.
contract MintFeeERC20 is MintERC20 {
    uint16 public feeBps; // e.g. 500 = 5% burned on each transfer
    constructor(string memory n, string memory s, uint16 feeBps_) MintERC20(n, s) { feeBps = feeBps_; }
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) { super._update(from, to, value); return; }
        uint256 fee = (value * feeBps) / 10000;
        super._update(from, address(0xdEaD), fee); // burn the fee
        super._update(from, to, value - fee);
    }
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

// Like MockRobinSwapLimit but its buy() consumes only part of the ETH and REFUNDS the rest to the
// caller — exactly what padRouter does on a near-graduation partial fill. Proves RobinLimit sweeps
// the refund back to the maker instead of stranding it.
contract MockRefundSwapLimit {
    address public immutable weth;
    MintERC20 public immutable coin;
    uint256 public coinPerEth;
    uint16 public refundBps;
    constructor(address weth_, MintERC20 coin_, uint256 coinPerEth_, uint16 refundBps_) {
        weth = weth_; coin = coin_; coinPerEth = coinPerEth_; refundBps = refundBps_;
    }
    function buy(address token, uint256 minOut) external payable returns (uint256 tokensOut) {
        require(token == address(coin), "coin");
        uint256 refund = (msg.value * refundBps) / 10000;
        uint256 consumed = msg.value - refund;
        tokensOut = (consumed * coinPerEth) / 1e18;
        require(tokensOut >= minOut, "min");
        coin.mint(msg.sender, tokensOut);
        if (refund > 0) { (bool ok,) = msg.sender.call{value: refund}(""); require(ok, "refund"); }
    }
    function sell(address, uint256, uint256) external pure returns (uint256) { revert("n/a"); }
    receive() external payable {}
}

// A venue whose sell() consumes only PART of amountIn and returns the unconsumed coin to the caller,
// exactly like padRouter on a floor/partial fill. Proves RobinLimit sweeps the leftover to the maker.
contract MockPartialSellLimit {
    address public immutable weth;
    MintERC20 public immutable coin;
    uint256 public coinPerEth;
    uint16 public consumeBps; // portion of amountIn actually sold; the rest is refunded
    constructor(address weth_, MintERC20 coin_, uint256 coinPerEth_, uint16 consumeBps_) {
        weth = weth_; coin = coin_; coinPerEth = coinPerEth_; consumeBps = consumeBps_;
    }
    function buy(address, uint256) external payable returns (uint256) { revert("n/a"); }
    function sell(address token, uint256 amountIn, uint256 minOutEth) external returns (uint256 ethOut) {
        require(token == address(coin), "coin");
        IERC20(address(coin)).transferFrom(msg.sender, address(this), amountIn);
        uint256 consumed = (amountIn * consumeBps) / 10000;
        if (consumed < amountIn) IERC20(address(coin)).transfer(msg.sender, amountIn - consumed); // refund unconsumed
        ethOut = (consumed * 1e18) / coinPerEth;
        require(ethOut >= minOutEth, "min");
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "eth");
    }
    receive() external payable {}
}
