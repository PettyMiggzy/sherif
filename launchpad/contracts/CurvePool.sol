// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurveBondDeployer {
    function deploy(address token, address weth, address v3Factory, address platform, address curve)
        external
        returns (address);
}

interface ICurveBond {
    function post(uint256 sherwoodWeth, uint256 sherwoodTokens, uint256 bountyWeth, uint256 ambushTokens) external;
}

/// @title CurvePool — a bonding curve that IS a real Uniswap v3 pool (DEX + DexScreener from block one)
/// @notice Instead of a math curve holding ETH off-DEX, the launch seeds the token as a single-sided
/// concentrated v3 position spanning [start, grad] price. That position behaves like a bonding curve — buyers
/// swap WETH in and walk the price up the range — but it's a genuine Uniswap pool, so DexScreener indexes and
/// charts it the moment it's created. When price reaches the graduation end (the curve is bought out), anyone
/// calls `graduate()`: it collects the raised WETH + any unsold token and posts the Bond (Sherwood + Bounty +
/// Ambush) into the SAME pool. No ETH from the platform — the token seeds its own liquidity; buyers bring ETH.
contract CurvePool is IUniswapV3MintCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    int24 public constant SPACING = 200;
    uint128 internal constant U128_MAX = type(uint128).max;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Factory public immutable v3Factory;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    address public immutable platform; // buy-side (LP) fees + graduation sweep
    address public immutable dev; // project dev
    address public immutable bondDeployer;
    bool public immutable tokenIsToken0;

    uint256 public immutable curveSupply; // seeded as the single-sided curve
    uint256 public immutable ambushSupply; // handed to the Bond's Ambush at graduation
    int24 public immutable startTick; // price at launch (curve bottom)
    int24 public immutable gradTick; // price when the curve is bought out (graduation)

    uint16 public constant SHERWOOD_WETH_BPS = 6000; // 60% of the raise -> Sherwood LP, 40% -> Bounty floor

    bool public seeded;
    bool public graduated;
    address public bond;
    int24 public curveLo;
    int24 public curveHi;
    uint128 public curveL;

    bool private _minting;

    error NotSeeded();
    error AlreadySeeded();
    error AlreadyGraduated();
    error NotReady();
    error NotPool();

    event Seeded(int24 curveLo, int24 curveHi, uint128 liquidity);
    event Graduated(address indexed bond, uint256 raisedWeth, uint256 leftoverToken);

    /// @param curveWidth_ tick span of the curve (start->grad), a positive multiple of SPACING.
    constructor(
        address token_,
        address weth_,
        address v3Factory_,
        address platform_,
        address dev_,
        address bondDeployer_,
        uint256 curveSupply_,
        uint256 ambushSupply_,
        int24 startTick_,
        int24 curveWidth_
    ) {
        require(
            token_ != address(0) && weth_ != address(0) && v3Factory_ != address(0) && platform_ != address(0)
                && dev_ != address(0) && bondDeployer_ != address(0),
            "zero"
        );
        require(curveSupply_ > 0 && curveWidth_ > 0 && curveWidth_ % SPACING == 0 && startTick_ % SPACING == 0, "params");
        token = IERC20(token_);
        WETH = weth_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        platform = platform_;
        dev = dev_;
        bondDeployer = bondDeployer_;
        curveSupply = curveSupply_;
        ambushSupply = ambushSupply_;
        startTick = startTick_;

        bool tIs0 = token_ < weth_;
        tokenIsToken0 = tIs0;
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
        // The curve holds only the TOKEN. token0 => the token is on the ABOVE-price side (price rises with
        // tick); token1 => the token is on the BELOW-price side (price rises as tick falls).
        gradTick = tIs0 ? startTick_ + curveWidth_ : startTick_ - curveWidth_;

        // Claim + initialize the pool at the start price (DEX + DexScreener live from here).
        address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, POOL_FEE);
        if (p == address(0)) p = IUniswapV3Factory(v3Factory_).createPool(token_, weth_, POOL_FEE);
        IUniswapV3Pool(p).initialize(PoolMath.getSqrtRatioAtTick(startTick_));
        pool = IUniswapV3Pool(p);
    }

    /// @notice Seed the curve — mint the single-sided token position. Call once, after this contract has been
    /// funded with `curveSupply + ambushSupply` tokens. Permissionless (idempotent-guarded).
    function seed() external nonReentrant {
        if (seeded) revert AlreadySeeded();
        seeded = true;
        // Curve range: token0 => [start, grad] above; token1 => [grad, start] below.
        (int24 lo, int24 hi) = tokenIsToken0 ? (startTick, gradTick) : (gradTick, startTick);
        curveLo = lo;
        curveHi = hi;
        uint128 L =
            PoolMath.singleSidedLiquidity(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), curveSupply, tokenIsToken0);
        curveL = L;
        _mint(lo, hi, L);
        pool.increaseObservationCardinalityNext(200); // arm the TWAP now (for the Bond's poke guard later)
        emit Seeded(lo, hi, L);
    }

    /// @notice The pool price at graduation (the curve's top). Buyers/routers cap the buyout swap here.
    function gradSqrtPriceX96() external view returns (uint160) {
        return PoolMath.getSqrtRatioAtTick(gradTick);
    }

    /// @notice Progress: has price reached the graduation end (curve bought out)?
    function ready() public view returns (bool) {
        if (!seeded || graduated) return false;
        (, int24 tick,,,,,) = pool.slot0();
        return tokenIsToken0 ? tick >= gradTick : tick <= gradTick;
    }

    /// @notice Graduate — collect the raised WETH + unsold token from the curve and post the Bond. Permissionless.
    function graduate() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        if (!ready()) revert NotReady();
        graduated = true;

        // pull the whole curve position back here (raised WETH + any unsold token)
        pool.burn(curveLo, curveHi, curveL);
        (uint256 c0, uint256 c1) = pool.collect(address(this), curveLo, curveHi, U128_MAX, U128_MAX);
        (uint256 raisedWeth, uint256 leftToken) = tokenIsToken0 ? (c1, c0) : (c0, c1);
        require(raisedWeth > 0, "empty");
        if (leftToken > 0) token.safeTransfer(DEAD, leftToken); // burn any tiny unsold curve remainder

        // Split the raise (Sherwood LP / Bounty floor). The Sherwood LP needs tokens too — the curve sold all
        // of its own, so pair them from the 25% Ambush reserve at the graduation price; the rest is the Ambush.
        uint256 sherwoodWeth = (raisedWeth * SHERWOOD_WETH_BPS) / 10_000;
        uint256 bountyWeth = raisedWeth - sherwoodWeth;
        uint256 quote = PoolMath.quoteWethPerToken(PoolMath.getSqrtRatioAtTick(gradTick), tokenIsToken0);
        uint256 sherwoodTokens = Math.min(ambushSupply, Math.mulDiv(sherwoodWeth, 1e18, quote));
        uint256 ambushForBond = ambushSupply - sherwoodTokens;

        address b = ICurveBondDeployer(bondDeployer).deploy(address(token), WETH, address(v3Factory), platform, address(this));
        bond = b;
        IERC20(WETH).safeTransfer(b, raisedWeth);
        IERC20(token).safeTransfer(b, ambushSupply); // = sherwoodTokens + ambushForBond
        ICurveBond(b).post(sherwoodWeth, sherwoodTokens, bountyWeth, ambushForBond);

        // sweep any WETH dust
        uint256 wethDust = IERC20(WETH).balanceOf(address(this));
        if (wethDust > 0) IERC20(WETH).safeTransfer(platform, wethDust);

        emit Graduated(b, raisedWeth, leftToken);
    }

    function _mint(int24 lo, int24 hi, uint128 L) internal {
        _minting = true;
        pool.mint(address(this), lo, hi, L, "");
        _minting = false;
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        require(_minting, "no mint");
        if (amount0Owed > 0) IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransfer(msg.sender, amount1Owed);
    }
}
