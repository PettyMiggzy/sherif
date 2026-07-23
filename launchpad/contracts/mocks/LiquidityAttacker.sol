// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool, IUniswapV3MintCallback, IUniswapV3SwapCallback} from "../interfaces/IUniswapV3.sol";

/// @notice Test-only adversary: mints a REAL v3 position into a live pool (to plant liquidity just above the
/// curve ceiling) and can shove spot into the empty zone — the exact attack the audit flagged against the
/// graduate() nudge. The caller must approve this contract for both tokens.
contract LiquidityAttacker is IUniswapV3MintCallback, IUniswapV3SwapCallback {
    function mint(address pool, int24 lo, int24 hi, uint128 liq) external {
        IUniswapV3Pool(pool).mint(address(this), lo, hi, liq, abi.encode(msg.sender));
    }

    function shove(address pool, bool zeroForOne, int256 amount, uint160 limit) external {
        IUniswapV3Pool(pool).swap(msg.sender, zeroForOne, amount, limit, abi.encode(msg.sender));
    }

    function uniswapV3MintCallback(uint256 a0, uint256 a1, bytes calldata data) external override {
        address payer = abi.decode(data, (address));
        if (a0 > 0) IERC20(IUniswapV3Pool(msg.sender).token0()).transferFrom(payer, msg.sender, a0);
        if (a1 > 0) IERC20(IUniswapV3Pool(msg.sender).token1()).transferFrom(payer, msg.sender, a1);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata data) external override {
        address payer = abi.decode(data, (address));
        if (d0 > 0) IERC20(IUniswapV3Pool(msg.sender).token0()).transferFrom(payer, msg.sender, uint256(d0));
        if (d1 > 0) IERC20(IUniswapV3Pool(msg.sender).token1()).transferFrom(payer, msg.sender, uint256(d1));
    }
}
