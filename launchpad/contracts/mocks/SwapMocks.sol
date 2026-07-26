// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Mocks for RobinSwap tests: a full ERC20, a WETH9 with depositTo, a SwapRouter02 stand-in
// (pulls tokenIn, produces tokenOut at a settable rate), and a RewardVault stand-in that
// records accruals per (coin, side).

contract RsERC20 {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(string memory n, string memory s) { name = n; symbol = s; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address sp, uint256 a) external returns (bool) { allowance[msg.sender][sp] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract RsWETH9 {
    string public name = "Wrapped ETH";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function depositTo(address to) external payable { balanceOf[to] += msg.value; }
    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        (bool ok, ) = msg.sender.call{value: a}(""); require(ok, "weth send");
    }
    function approve(address sp, uint256 a) external returns (bool) { allowance[msg.sender][sp] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
    receive() external payable {}
}

contract MockSwapRouter02 {
    address public weth;
    uint256 public rate = 1e18; // amountOut = amountIn * rate / 1e18
    constructor(address _weth) { weth = _weth; }
    function setRate(uint256 r) external { rate = r; }

    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        (bool pulled, ) = p.tokenIn.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), p.amountIn));
        require(pulled, "pull");
        amountOut = (p.amountIn * rate) / 1e18;
        require(amountOut >= p.amountOutMinimum, "Too little received");
        if (p.tokenOut == weth) {
            (bool o, ) = weth.call{value: amountOut}(abi.encodeWithSignature("depositTo(address)", p.recipient));
            require(o, "weth out");
        } else {
            (bool o, ) = p.tokenOut.call(abi.encodeWithSignature("mint(address,uint256)", p.recipient, amountOut));
            require(o, "mint out");
        }
    }
    receive() external payable {}
}

contract MockRewardVault {
    mapping(address => mapping(uint8 => uint256)) public accrued; // coin => side => total ETH
    bool public failNext;
    function setFail(bool f) external { failNext = f; }
    function accrue(address coin, uint8 side) external payable { require(!failNext, "vault fail"); accrued[coin][side] += msg.value; }
    receive() external payable {}
}
