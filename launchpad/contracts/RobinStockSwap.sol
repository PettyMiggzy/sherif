// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// RobinStockSwap — swap ANY listed token ↔ ANY listed token (incl. tokenized stocks),
// and the platform earns a fee on every swap.
//
// The whole point: let a user trade a memecoin (or ETH) straight into a tokenized stock
// (NVDA, AAPL, …) and back, in one tx, while Robin Labs skims a CONFIGURABLE fee. Every
// route hops through WETH — tokenIn → WETH → tokenOut — because that is where the chain's
// liquidity lives (each token has a token/WETH pool). The fee is skimmed on the WETH MID-LEG,
// so the platform's cut is always clean, ETH-denominated revenue no matter which pair trades.
//
// Shaped on RobinSwap (already live): a curated register-once allowlist, escrow-then-withdraw
// fees (a payout can never revert a trade), fee-on-transfer-safe measured deltas, nonReentrant,
// native-ETH↔WETH wrapping, and a hard fee cap. Legacy (type-0) txs on Robinhood Chain.
//
// ── LEGAL GATE (read before mainnet) ─────────────────────────────────────────────────────
// Tokenized Robinhood Stock Tokens are REGULATED tokenized debt securities: available outside
// the US only, KYC/geo-gated, and governed by a registry that can block addresses. Running a
// fee-taking venue that facilitates trading them can implicate broker/intermediary rules. This
// contract is the on-chain plumbing ONLY. Before it is used with any stock listing the operator
// MUST: (1) geo/KYC-gate the front-end, (2) rely on the stock token's own registry gating (a
// blocked router/user simply cannot receive the token — the swap reverts, funds are returned),
// and (3) obtain securities/legal sign-off. Treat as unaudited + legally-gated until both a
// security audit and that sign-off are done — exactly as the RobinBlue stock pad required.
// ─────────────────────────────────────────────────────────────────────────────

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
    function withdraw(uint256) external;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract RobinStockSwap is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant BPS = 10000;
    uint16 public constant MAX_FEE_BPS = 300; // hard ceiling: the platform fee can never exceed 3%

    address public immutable WETH;
    address public immutable swapRouter; // Uniswap SwapRouter02 on Robinhood Chain (same one RobinSwap uses)

    struct Listing {
        uint24 poolFee; // the token/WETH pool's fee tier (e.g. 10000 = 1%, 3000 = 0.3%)
        bool set; // register-once presence
        bool paused; // curator can halt a listing without deleting it
    }
    mapping(address => Listing) public listing;
    mapping(address => bool) public isCurator; // allowlist governors (owner-managed)

    uint16 public feeBps = 100; // platform fee, default 1% of the WETH mid-leg; ≤ MAX_FEE_BPS
    address public platformWallet; // fee recipient (0 → owner())
    uint256 public platformEscrowWeth; // accrued platform fees, held as WETH until withdrawn

    error Unknown();
    error Paused();
    error Dust();
    error Slippage();
    error NotCurator();
    error AlreadyListed();
    error BadArg();
    error SameToken();
    error PayFailed();

    event Listed(address indexed token, uint24 poolFee);
    event ListingPaused(address indexed token, bool paused);
    event Relisted(address indexed token, uint24 poolFee);
    event FeeBpsSet(uint16 feeBps);
    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeWeth
    );
    event PlatformWithdrawn(address indexed to, uint256 amount);

    constructor(address weth_, address swapRouter_, address owner_) Ownable(owner_) {
        if (weth_ == address(0) || swapRouter_ == address(0)) revert BadArg();
        WETH = weth_;
        swapRouter = swapRouter_;
        isCurator[owner_] = true;
    }

    // ── swapping ─────────────────────────────────────────────────────────────────

    /// @notice Swap `amountIn` of `tokenIn` into `tokenOut`, routed tokenIn → WETH → tokenOut, with the platform
    /// fee skimmed on the WETH mid-leg. Caller must have approved this contract for `amountIn` of `tokenIn`.
    /// Pass `tokenOut == WETH` to cash out to native ETH (the WETH leg is unwrapped to the recipient).
    /// @param minOut minimum `tokenOut` (or ETH, if tokenOut==WETH) the caller will accept — the whole-route
    /// slippage guard. `recipient` receives the output (0 → msg.sender).
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert Dust();
        address to = recipient == address(0) ? msg.sender : recipient;

        // pull tokenIn (fee-on-transfer safe: use the amount we actually received)
        uint256 preIn = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 gotIn = IERC20(tokenIn).balanceOf(address(this)) - preIn;
        if (gotIn == 0) revert Dust();

        // leg 1: tokenIn → WETH (skipped when tokenIn IS WETH)
        uint256 wethMid = _toWeth(tokenIn, gotIn);

        // skim the platform fee on the WETH mid-leg
        uint256 fee = (wethMid * feeBps) / BPS;
        platformEscrowWeth += fee;
        uint256 afterFee = wethMid - fee;
        if (afterFee == 0) revert Dust();

        // leg 2: WETH → tokenOut (or unwrap to native ETH when tokenOut IS WETH)
        amountOut = _fromWeth(tokenOut, afterFee, to);
        if (amountOut < minOut) revert Slippage();

        emit Swapped(msg.sender, tokenIn, tokenOut, gotIn, amountOut, fee);
    }

    /// @notice Swap native ETH into `tokenOut` (ETH → WETH → tokenOut), platform fee on the WETH mid-leg.
    function swapFromETH(address tokenOut, uint256 minOut, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        if (tokenOut == WETH || tokenOut == address(0)) revert SameToken();
        if (msg.value == 0) revert Dust();
        address to = recipient == address(0) ? msg.sender : recipient;

        IWETH9(WETH).deposit{value: msg.value}();

        uint256 fee = (msg.value * feeBps) / BPS;
        platformEscrowWeth += fee;
        uint256 afterFee = msg.value - fee;
        if (afterFee == 0) revert Dust();

        amountOut = _fromWeth(tokenOut, afterFee, to);
        if (amountOut < minOut) revert Slippage();

        emit Swapped(msg.sender, address(0), tokenOut, msg.value, amountOut, fee);
    }

    /// @dev tokenIn → WETH. Returns the WETH actually received (measured). No-op passthrough if tokenIn IS WETH.
    function _toWeth(address tokenIn, uint256 amountIn) internal returns (uint256 wethOut) {
        if (tokenIn == WETH) return amountIn; // already WETH; caller sent WETH in
        Listing memory L = listing[tokenIn];
        if (!L.set) revert Unknown();
        if (L.paused) revert Paused();

        uint256 preW = IWETH9(WETH).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);
        ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(tokenIn, WETH, L.poolFee, address(this), amountIn, 0, 0)
        );
        IERC20(tokenIn).forceApprove(swapRouter, 0); // leave no standing approval
        wethOut = IWETH9(WETH).balanceOf(address(this)) - preW;
        if (wethOut == 0) revert Dust();
    }

    /// @dev WETH → tokenOut to `to` (measured). If tokenOut IS WETH, unwrap to native ETH for `to` instead.
    function _fromWeth(address tokenOut, uint256 wethIn, address to) internal returns (uint256 out) {
        if (tokenOut == WETH) {
            IWETH9(WETH).withdraw(wethIn);
            (bool ok,) = to.call{value: wethIn}("");
            if (!ok) revert PayFailed();
            return wethIn;
        }
        Listing memory L = listing[tokenOut];
        if (!L.set) revert Unknown();
        if (L.paused) revert Paused();

        uint256 preOut = IERC20(tokenOut).balanceOf(to);
        IWETH9(WETH).approve(swapRouter, wethIn);
        ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(WETH, tokenOut, L.poolFee, to, wethIn, 0, 0)
        );
        IWETH9(WETH).approve(swapRouter, 0);
        out = IERC20(tokenOut).balanceOf(to) - preOut; // fee-on-transfer/registry-haircut safe
    }

    // ── permissionless payout ─────────────────────────────────────────────────────

    /// @notice Sweep accrued platform fees (WETH) to the platform wallet. Permissionless — the only sink is the
    /// owner-set `platformWallet` (or owner()), so an untrusted caller can only pay gas to flush, never redirect.
    function withdrawPlatform() external nonReentrant {
        uint256 amt = platformEscrowWeth;
        if (amt == 0) return;
        platformEscrowWeth = 0;
        address to = platformWallet == address(0) ? owner() : platformWallet;
        IERC20(WETH).safeTransfer(to, amt);
        emit PlatformWithdrawn(to, amt);
    }

    // ── curation (register-once, curator-gated) ─────────────────────────────────────

    function list(address token, uint24 poolFee) external {
        if (!isCurator[msg.sender]) revert NotCurator();
        if (token == address(0) || token == WETH || poolFee == 0) revert BadArg();
        if (listing[token].set) revert AlreadyListed();
        listing[token] = Listing(poolFee, true, false);
        emit Listed(token, poolFee);
    }

    /// @notice Fix a mislisted pool-fee tier WITHOUT a redeploy (list() stays register-once); preserves paused.
    function relist(address token, uint24 poolFee) external {
        if (!isCurator[msg.sender]) revert NotCurator();
        if (poolFee == 0) revert BadArg();
        if (!listing[token].set) revert Unknown();
        listing[token].poolFee = poolFee;
        emit Relisted(token, poolFee);
    }

    function setPaused(address token, bool paused) external {
        if (!isCurator[msg.sender]) revert NotCurator();
        if (!listing[token].set) revert Unknown();
        listing[token].paused = paused;
        emit ListingPaused(token, paused);
    }

    // ── owner config ───────────────────────────────────────────────────────────────

    function setCurator(address who, bool on) external onlyOwner {
        isCurator[who] = on;
    }

    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert BadArg();
        feeBps = bps;
        emit FeeBpsSet(bps);
    }

    function setPlatformWallet(address w) external onlyOwner {
        platformWallet = w;
    }

    /// Ownership is load-bearing (platformEscrow falls back to owner() when platformWallet is unset), so
    /// renouncing would let a withdraw send fees to address(0). Disabled; use Ownable2Step transfer/accept.
    function renounceOwnership() public pure override {
        revert("disabled");
    }

    /// A new owner (via acceptOwnership) is automatically a curator, so control never lands with an owner who
    /// can't manage listings. The prior owner's curator rights persist until explicitly revoked.
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        if (newOwner != address(0)) isCurator[newOwner] = true;
    }

    receive() external payable {} // WETH.withdraw sends ETH here during a stock→ETH cash-out
}
