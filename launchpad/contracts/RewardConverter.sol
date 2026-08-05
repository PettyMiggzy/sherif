// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

interface IRobinStaking {
    function notifyReward(address asset, uint256 amount) external;
    function notifyRewardETH() external payable;
    function ETH() external view returns (address);
}

/// @title RewardConverter — turn pad fee ETH into real Robinhood Stock Token rewards
/// @notice The bridge between the pad's ETH fee revenue and a staking pool's stock-reward stream. A keeper
/// funds this contract with ETH (the platform's reward slice), then calls `convertAndFund`, which swaps
/// ETH→WETH→<stock> through the same Uniswap-V3 SwapRouter the pad already uses, and forwards the resulting
/// stock tokens straight into the pool's `notifyReward` stream. So "stake $ROBIN, earn AAPL/NVDA" is funded
/// automatically from fees — no manual stock buying — for the liquid names.
///
/// SLIPPAGE IS THE WHOLE GAME: the stock/WETH pools on Robinhood Chain are shallow, so every conversion
/// carries a keeper-supplied `minOut` (computed off-chain from a fresh quote). If the swap can't meet it,
/// the whole call reverts and no bad-priced rewards are streamed. `convertAndFund` is keeper-gated so
/// conversions happen at sane sizes/times; `minOut` protects value regardless of who calls.
///
/// For illiquid names (e.g. SGOV today) skip the swap entirely and use `fundToken` to stream tokens the
/// treasury already holds, or `fundEth` to stream plain ETH.
contract RewardConverter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable WETH;
    address public immutable swapRouter;

    mapping(address => bool) public isKeeper;

    error NotKeeper();
    error ZeroAddr();
    error Zero();
    error InsufficientEth();
    error Slippage();
    error Expired();

    event KeeperSet(address indexed who, bool allowed);
    event Converted(
        address indexed pool, address indexed stock, uint24 fee, uint256 ethIn, uint256 stockOut, uint256 minOut
    );
    event FundedToken(address indexed pool, address indexed token, uint256 amount);
    event FundedEth(address indexed pool, uint256 amount);
    event EthRecovered(address indexed to, uint256 amount);
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    constructor(address weth_, address swapRouter_, address owner_) Ownable(owner_) {
        if (weth_ == address(0) || swapRouter_ == address(0) || owner_ == address(0)) revert ZeroAddr();
        WETH = weth_;
        swapRouter = swapRouter_;
        isKeeper[owner_] = true;
    }

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        _;
    }

    /// @notice Swap `ethIn` of this contract's ETH into `stock` (via the WETH/`stock` V3 pool at `fee`), then
    /// stream the stock tokens into `pool`. Reverts unless the swap yields at least `minOut` (slippage guard).
    /// This contract must be an authorized rewarder on `pool`.
    /// @param sqrtPriceLimitX96 optional in-pool price ceiling (0 = none) — a hard on-chain cap on price impact
    ///        that bounds a sandwich beyond `minOut`, useful on the shallow stock pools.
    /// @param deadline latest block timestamp the swap may execute — SwapRouter02's own struct has no deadline,
    ///        so a slow legacy (type-0) tx could otherwise be held in the mempool and mined at the worst price.
    function convertAndFund(
        address pool,
        address stock,
        uint24 fee,
        uint256 ethIn,
        uint256 minOut,
        uint160 sqrtPriceLimitX96,
        uint256 deadline
    ) external onlyKeeper nonReentrant returns (uint256 stockOut) {
        if (pool == address(0) || stock == address(0)) revert ZeroAddr();
        if (ethIn == 0 || minOut == 0) revert Zero();
        if (block.timestamp > deadline) revert Expired();
        if (ethIn > address(this).balance) revert InsufficientEth();

        IWETH9(WETH).deposit{value: ethIn}();
        IERC20(WETH).forceApprove(swapRouter, ethIn);

        stockOut = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(WETH, stock, fee, address(this), ethIn, minOut, sqrtPriceLimitX96)
        );
        if (stockOut < minOut) revert Slippage(); // defense-in-depth beyond the router's own check

        IERC20(stock).forceApprove(pool, stockOut);
        IRobinStaking(pool).notifyReward(stock, stockOut);
        emit Converted(pool, stock, fee, ethIn, stockOut, minOut);
    }

    /// @notice Stream `amount` of `token` (already held by this contract, e.g. treasury-bought SGOV) into
    /// `pool` — the pre-funded path for illiquid reward assets, no swap.
    function fundToken(address pool, address token, uint256 amount) external onlyKeeper nonReentrant {
        if (pool == address(0) || token == address(0)) revert ZeroAddr();
        if (amount == 0) revert Zero();
        IERC20(token).forceApprove(pool, amount);
        IRobinStaking(pool).notifyReward(token, amount);
        emit FundedToken(pool, token, amount);
    }

    /// @notice Stream `amount` of this contract's ETH into `pool` as a plain-ETH reward (no stock conversion).
    function fundEth(address pool, uint256 amount) external onlyKeeper nonReentrant {
        if (pool == address(0)) revert ZeroAddr();
        if (amount == 0) revert Zero();
        if (amount > address(this).balance) revert InsufficientEth();
        IRobinStaking(pool).notifyRewardETH{value: amount}();
        emit FundedEth(pool, amount);
    }

    // ─────────────────────────────────────────────── admin ──

    function setKeeper(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert ZeroAddr();
        isKeeper[who] = allowed;
        emit KeeperSet(who, allowed);
    }

    /// @notice Recover ETH that shouldn't be here (owner-only escape hatch; conversions use `convertAndFund`).
    function recoverEth(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddr();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert InsufficientEth();
        emit EthRecovered(to, amount);
    }

    /// @notice Recover an ERC-20 held by this contract (owner-only).
    function recoverToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddr();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRecovered(token, to, amount);
    }

    /// @notice Accept ETH — the fee router / treasury funds reward conversions by sending ETH here.
    receive() external payable {}
}
