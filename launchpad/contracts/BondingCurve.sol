// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";
import {LiquidityLocker} from "./LiquidityLocker.sol";

/// @title BondingCurve
/// @notice A simple constant-product (x*y=k) bonding curve with virtual reserves, like ape.store /
/// pump.fun. Buyers trade ETH<->token on the curve for price discovery; when real ETH raised reaches
/// GRAD_TARGET the curve **graduates**: it seeds a Uniswap v3 pool at the curve's final price with the
/// unsold tokens + all raised ETH, permanently locks the LP, and disables curve trading forever.
///
/// Invariants (proven + brute-forced in sim/curve-sim.mjs):
///   INV-J:   reserveEth <= ceilDiv(K, reserveToken) after every op (buy floors, sell ceils). This is the
///            load-bearing property: it makes round-trip/sequence profit impossible and keeps the curve
///            solvent (reserveEth >= VIRT_ETH always).
///   INV-BAL: (reserveEth - VIRT_ETH) == real ETH backing the reserve (== raised()); accrued fees are held
///            separately in feesEth. The curve can only ever pay out ETH it actually took in.
///   INV-GRAD: graduation happens at most once, only when raised >= GRAD_TARGET, seeds the pool at the
///            curve's EXACT final price (continuous), burns the unsold remainder, and locks the LP.
contract BondingCurve is IUniswapV3MintCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    uint16 public constant FEE_BPS = 100; // 1% platform fee on buys and sells
    uint16 public constant CARDINALITY = 200; // TWAP observation slots armed at graduation (for the AthVault)

    // immutables
    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Factory public immutable v3Factory;
    LiquidityLocker public immutable locker;
    address public immutable platform; // 1% fee recipient
    address public immutable dev; // LP swap-fee beneficiary after graduation

    uint256 public immutable VIRT_ETH; // virtual ETH reserve (sets the starting price)
    uint256 public immutable CURVE_SUPPLY; // tokens for sale on the curve (must be funded to this contract)
    uint256 public immutable K; // = VIRT_ETH * CURVE_SUPPLY (constant product)
    uint256 public immutable GRAD_TARGET; // real ETH (net of fees) that triggers graduation
    uint160 public immutable gradSqrtPriceX96; // pool price committed + initialized at launch

    // anti-snipe (first window: cap the net ETH per buy; auto-expires)
    uint64 public immutable startTime;
    uint32 public immutable antiSnipeSecs;
    uint256 public immutable maxBuyWei;

    // state
    uint256 public reserveEth; // virtual + real
    uint256 public reserveToken; // tokens still in the curve
    uint256 public feesEth; // accrued platform fees (pull-over-push, so a bad platform can't brick trading)
    bool public graduated;
    address public pool;

    error AlreadyGraduated();
    error NotGraduated();
    error SnipeCap();
    error Slippage();
    error NothingOut();
    error NotPool();
    error TargetNotReached();

    event Buy(address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut, uint256 reserveEth, uint256 reserveToken);
    event Sell(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee, uint256 reserveEth, uint256 reserveToken);
    event Graduated(address indexed pool, uint256 ethToLp, uint256 tokensToLp, uint160 sqrtPriceX96);

    constructor(
        address token_,
        address weth_,
        address v3Factory_,
        address platform_,
        address dev_,
        uint256 virtEth_,
        uint256 curveSupply_,
        uint256 gradTarget_,
        uint32 antiSnipeSecs_,
        uint256 maxBuyWei_
    ) {
        require(
            token_ != address(0) && weth_ != address(0) && v3Factory_ != address(0)
                && platform_ != address(0) && dev_ != address(0),
            "zero addr"
        );
        require(virtEth_ > 0 && curveSupply_ > 0 && gradTarget_ > 0, "params");
        // graduation LP must be a meaningful fraction of the raise (bounds any rounding edge); the
        // continuous-price seeding already removes the step, this just rejects degenerate configs.
        require(gradTarget_ >= virtEth_, "grad<virt");
        token = IERC20(token_);
        WETH = weth_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        locker = new LiquidityLocker(address(this)); // curve owns its locker; LP locked to it forever
        platform = platform_;
        dev = dev_;
        VIRT_ETH = virtEth_;
        CURVE_SUPPLY = curveSupply_;
        K = virtEth_ * curveSupply_; // reverts on overflow (checked)
        GRAD_TARGET = gradTarget_;
        antiSnipeSecs = antiSnipeSecs_;
        maxBuyWei = maxBuyWei_;
        startTime = uint64(block.timestamp);

        reserveEth = virtEth_;
        reserveToken = curveSupply_;

        // Claim + initialize the Uniswap pool NOW, at the deterministic graduation price (the price when
        // raised == GRAD_TARGET). This closes the pre-initialization DoS: since we own+price the pool from
        // launch, no third party can initialize it off-price during the bonding phase to brick graduation.
        // (Deploy token+curve atomically — as CurveLaunchFactory does — so there's no gap before this runs.)
        uint256 gradRE = virtEth_ + gradTarget_;
        uint256 gradRT = K / gradRE;
        (,, uint256 ga0, uint256 ga1) = _orderedAddr(token_, weth_, gradRT, gradRE);
        uint160 sp = PoolMath.sqrtPriceX96FromAmounts(ga0, ga1);
        gradSqrtPriceX96 = sp;
        address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, POOL_FEE);
        if (p == address(0)) p = IUniswapV3Factory(v3Factory_).createPool(token_, weth_, POOL_FEE);
        IUniswapV3Pool(p).initialize(sp);
        pool = p;
    }

    /// @notice Real ETH raised so far (net of fees) = what's held for graduation.
    function raised() public view returns (uint256) {
        return reserveEth - VIRT_ETH;
    }

    /// @notice Current spot price, ETH-wei per 1e18 token (1e18-scaled). Never reverts. For display/UX.
    function spotPriceE18() public view returns (uint256) {
        return Math.mulDiv(reserveEth, 1e18, reserveToken);
    }

    /// @notice Progress toward graduation, in basis points (0..10000).
    function gradProgressBps() external view returns (uint256) {
        uint256 r = raised();
        return r >= GRAD_TARGET ? 10_000 : (r * 10_000) / GRAD_TARGET;
    }

    // --------------------------------------------------------------- buy
    /// @notice Buy tokens with ETH along the curve. 1% fee to platform; anti-snipe cap in the first window.
    function buy(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert AlreadyGraduated();
        uint256 fee = (msg.value * FEE_BPS) / 10_000;
        uint256 netEth = msg.value - fee;
        if (netEth == 0) revert NothingOut();
        if (block.timestamp < uint256(startTime) + antiSnipeSecs && netEth > maxBuyWei) revert SnipeCap();

        // Cap the graduating buy so `raised()` lands EXACTLY on GRAD_TARGET and refund the excess. This
        // makes graduation happen at the price the pool was initialized to at launch (price-continuous),
        // and removes any overshoot the last buyer would otherwise eat.
        uint256 refundEth;
        {
            uint256 room = GRAD_TARGET - raised(); // > 0 (not graduated)
            if (netEth > room) {
                uint256 acceptGross = Math.ceilDiv(room * 10_000, 10_000 - FEE_BPS);
                if (acceptGross > msg.value) acceptGross = msg.value;
                refundEth = msg.value - acceptGross;
                fee = acceptGross - room;
                netEth = room;
            }
        }

        // constant product: new token reserve = K / new eth reserve
        uint256 newReserveEth = reserveEth + netEth;
        // buy rounding is generous by <1 token-wei; safety comes from the sell-side ceilDiv + the
        // fees (invariant: reserveEth <= ceilDiv(K, reserveToken)), NOT from dust staying in the curve.
        uint256 newReserveToken = K / newReserveEth;
        tokensOut = reserveToken - newReserveToken;
        if (tokensOut < minTokensOut) revert Slippage();
        if (tokensOut == 0) revert NothingOut();

        reserveEth = newReserveEth;
        reserveToken = newReserveToken;
        feesEth += fee; // accrued, not pushed (a reverting platform must not brick buys)

        token.safeTransfer(msg.sender, tokensOut);
        if (refundEth > 0) _sendEth(msg.sender, refundEth); // return the overshoot (guarded by nonReentrant)
        emit Buy(msg.sender, msg.value - refundEth, fee, tokensOut, reserveEth, reserveToken);

        if (raised() >= GRAD_TARGET) _graduate();
    }

    // --------------------------------------------------------------- sell
    /// @notice Sell tokens back to the curve for ETH. 1% fee to platform.
    function sell(uint256 tokensIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        if (graduated) revert AlreadyGraduated();
        require(tokensIn > 0, "zero");
        // never let outstanding tokens on the curve exceed what was funded (solvency depends on it;
        // also rejects sells backed by any supply beyond CURVE_SUPPLY, e.g. a mis-funded/rebasing token)
        require(reserveToken + tokensIn <= CURVE_SUPPLY, "oversell");
        token.safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 newReserveToken = reserveToken + tokensIn;
        uint256 newReserveEth = Math.ceilDiv(K, newReserveToken); // ceil -> curve keeps dust (pays out less)
        uint256 grossOut = reserveEth - newReserveEth;
        if (grossOut == 0) revert NothingOut(); // sub-threshold sell would burn tokens for 0 ETH
        reserveToken = newReserveToken;
        reserveEth = newReserveEth;

        uint256 fee = (grossOut * FEE_BPS) / 10_000;
        ethOut = grossOut - fee;
        if (ethOut < minEthOut) revert Slippage();
        feesEth += fee; // accrued, not pushed

        _sendEth(msg.sender, ethOut);
        emit Sell(msg.sender, tokensIn, ethOut, fee, reserveEth, reserveToken);
    }

    /// @notice Send accrued platform fees to the fixed platform address. Permissionless; if the platform
    /// reverts on receipt only this call fails — trading is never affected.
    function withdrawFees() external nonReentrant {
        uint256 f = feesEth;
        feesEth = 0;
        if (f > 0) _sendEth(platform, f);
    }

    // --------------------------------------------------------------- graduation
    /// @notice Force-check graduation (also runs automatically at the end of a qualifying buy).
    function graduate() external nonReentrant {
        if (graduated) revert AlreadyGraduated();
        if (raised() < GRAD_TARGET) revert TargetNotReached();
        _graduate();
    }

    function _graduate() internal {
        graduated = true;
        uint256 ethToLp = raised(); // real ETH raised for LP (accrued fees stay claimable, not deposited)
        require(ethToLp > 0, "empty grad");

        // Seed the pool at the price it was committed to at launch (gradSqrtPriceX96). Choose tokensToLp so
        // ethToLp/tokensToLp matches that price; burn the unsold remainder (deflationary, no below-price dump).
        address p = pool; // created + initialized at launch
        uint256 quote = PoolMath.quoteWethPerToken(gradSqrtPriceX96, address(token) < WETH); // WETH-wei per 1e18 token
        require(quote > 0, "bad price");
        uint256 tokensToLp = Math.min(reserveToken, Math.mulDiv(ethToLp, 1e18, quote));
        require(tokensToLp > 0, "empty grad");
        uint256 burnTokens = reserveToken - tokensToLp;
        if (burnTokens > 0) token.safeTransfer(0x000000000000000000000000000000000000dEaD, burnTokens);

        IWETH9(WETH).deposit{value: ethToLp}();

        (address token0, address token1, uint256 amt0, uint256 amt1) =
            _orderedAddr(address(token), WETH, tokensToLp, ethToLp);

        // The pool is ours from launch, so it should still be at gradSqrtPriceX96. Requiring this refuses to
        // mint into a pool whose price a griefer moved (they'd need to add real liquidity + swap — costly, no
        // profit, and defeated by the private mempool); that reverts graduation (no theft, ETH exitable).
        (uint160 existing,,,,,,) = IUniswapV3Pool(p).slot0();
        require(existing == gradSqrtPriceX96, "pool price moved");
        IUniswapV3Pool(p).increaseObservationCardinalityNext(CARDINALITY); // arm the TWAP for the AthVault

        uint128 L = PoolMath.fullRangeLiquidity(gradSqrtPriceX96, amt0, amt1);
        IUniswapV3Pool(p).mint(address(locker), PoolMath.MIN_TICK, PoolMath.MAX_TICK, L, abi.encode(token0, token1));
        locker.register(p, dev);

        // sweep any token/WETH dust left by rounding to the burn/dev
        uint256 tokDust = token.balanceOf(address(this));
        if (tokDust > 0) token.safeTransfer(0x000000000000000000000000000000000000dEaD, tokDust);
        uint256 wethDust = IERC20(WETH).balanceOf(address(this));
        if (wethDust > 0) IERC20(WETH).safeTransfer(dev, wethDust);

        emit Graduated(p, ethToLp, tokensToLp, gradSqrtPriceX96);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external override {
        (address token0, address token1) = abi.decode(data, (address, address));
        if (msg.sender != v3Factory.getPool(token0, token1, POOL_FEE)) revert NotPool();
        if (amount0Owed > 0) IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransfer(msg.sender, amount1Owed);
    }

    // --------------------------------------------------------------- helpers
    function _orderedAddr(address t, address w, uint256 tokenAmt, uint256 ethAmt)
        internal
        pure
        returns (address token0, address token1, uint256 amt0, uint256 amt1)
    {
        return t < w ? (t, w, tokenAmt, ethAmt) : (w, t, ethAmt, tokenAmt);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "eth send");
    }
}
