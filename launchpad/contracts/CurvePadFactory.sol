// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchTokenDeployer, CurvePoolDeployer} from "./deployers/CurveDeployers.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurvePool {
    function pool() external view returns (address);
    function seed() external;
}

/// @title CurvePadFactory — DEX-day-one launchpad (the NOXA-style model, plus the Bond)
/// @notice One `launch()` call: deploys a clean anti-snipe token, creates a REAL Uniswap v3 pool, seeds the
/// token as a single-sided "curve" position, enables trading, and (optionally) executes the creator's own
/// **dev buy** of up to 2% in the same transaction — before anyone else can trade — so the dev is never
/// sniped on their own coin. Token is on Uniswap + DexScreener from block one. Free to launch; the platform
/// funds nothing (the token seeds its own liquidity); the dev buy is optional and paid by the dev.
contract CurvePadFactory is Ownable2Step, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    uint16 public constant AMBUSH_BPS = 2500; // 25% -> the Bond's Ambush; 75% is the curve
    uint24 public constant POOL_FEE = 10000;
    uint16 public constant MAX_DEVBUY_BPS = 200; // dev buy capped at 2% of supply
    int24 public constant DEVBUY_SPAN = 600; // price-limit span (~2%) so a dev buy can't run the curve

    address public immutable WETH;
    address public immutable v3Factory;
    LaunchTokenDeployer public immutable tokenDeployer;
    CurvePoolDeployer public immutable curveDeployer;
    address public immutable bondDeployer;

    address public platform;
    bool private _swapping; // guards the swap callback (WETH is only ever transient, mid-launch)

    // ---- fixed terms ----
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    int24 public constant START_TICK_MAG = 207200; // ~1e-9 WETH/token start; sign set by ordering
    int24 public constant CURVE_WIDTH = 35800; // ~36x span to graduation

    struct LaunchParams {
        string name;
        string symbol;
        address dev;
    }

    struct Record {
        address token;
        address curve;
        address dev;
        uint256 at;
    }

    mapping(address => Record) public recordOf;
    address[] public allTokens;

    error BadValue();

    event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought);
    event PlatformChanged(address platform);

    constructor(
        address weth_,
        address v3Factory_,
        address platform_,
        address owner_,
        address tokenDeployer_,
        address curveDeployer_,
        address bondDeployer_
    ) Ownable(owner_) {
        require(
            weth_ != address(0) && v3Factory_ != address(0) && platform_ != address(0) && tokenDeployer_ != address(0)
                && curveDeployer_ != address(0) && bondDeployer_ != address(0),
            "zero"
        );
        WETH = weth_;
        v3Factory = v3Factory_;
        platform = platform_;
        tokenDeployer = LaunchTokenDeployer(tokenDeployer_);
        curveDeployer = CurvePoolDeployer(curveDeployer_);
        bondDeployer = bondDeployer_;
    }

    receive() external payable {} // for WETH.withdraw refunds during a dev buy

    /// @notice One tx: token + real pool + seeded curve + trading on. Send ETH to also make the dev's first
    /// buy (≤2%) in the same tx, before trading opens to anyone else. DEX + DexScreener day one.
    function launch(LaunchParams calldata p) external payable returns (address token, address curve, address pool) {
        if (p.dev == address(0)) revert BadValue();

        uint256 ambushAmt = (TOTAL_SUPPLY * AMBUSH_BPS) / 10_000;
        uint256 curveAmt = TOTAL_SUPPLY - ambushAmt;

        LaunchToken.GuardConfig memory g = LaunchToken.GuardConfig({
            deadSecs: 2,
            phase1Secs: 60,
            antiSnipeSecs: 300,
            maxTxBps1: 50,
            maxWalletBps1: 100,
            maxTxBps2: 100,
            maxWalletBps2: 200,
            cooldownSecs: 2
        });
        token = tokenDeployer.deploy(p.name, p.symbol, TOTAL_SUPPLY, address(this), g);

        int24 startTick = token < WETH ? -START_TICK_MAG : START_TICK_MAG;
        curve = curveDeployer.deploy(
            token, WETH, v3Factory, platform, p.dev, bondDeployer, curveAmt, ambushAmt, startTick, CURVE_WIDTH
        );
        pool = ICurvePool(curve).pool();

        IERC20(token).safeTransfer(curve, TOTAL_SUPPLY);
        LaunchToken(token).enableTrading(pool, curve, uint64(block.timestamp));
        ICurvePool(curve).seed();

        // optional dev buy (≤2%), atomic and ahead of the field
        uint256 devBought;
        if (msg.value > 0) devBought = _devBuy(token, pool, startTick, p.dev);

        recordOf[token] = Record(token, curve, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, curve, pool, p.dev, devBought);
    }

    function _devBuy(address token, address pool, int24 startTick, address dev) internal returns (uint256 bought) {
        bool tokenIsToken0 = token < WETH;
        bool zeroForOne = !tokenIsToken0; // buying the token: WETH-in. WETH is token0 iff !tokenIsToken0.
        // cap the price move to ~2% into the curve so a big dev buy can't run the whole thing (excess refunded)
        int24 capTick = tokenIsToken0 ? startTick + DEVBUY_SPAN : startTick - DEVBUY_SPAN;
        uint160 sqrtLimit = PoolMath.getSqrtRatioAtTick(capTick);

        IWETH9(WETH).deposit{value: msg.value}();
        _swapping = true;
        IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(msg.value), sqrtLimit, "");
        _swapping = false;

        // deliver bought tokens to the dev; enforce the 2% cap; refund any unused ETH
        bought = IERC20(token).balanceOf(address(this));
        require(bought <= (TOTAL_SUPPLY * MAX_DEVBUY_BPS) / 10_000, "dev>2%");
        if (bought > 0) IERC20(token).safeTransfer(dev, bought);
        uint256 leftWeth = IERC20(WETH).balanceOf(address(this));
        if (leftWeth > 0) {
            IWETH9(WETH).withdraw(leftWeth);
            (bool ok,) = dev.call{value: leftWeth}("");
            require(ok, "refund");
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        require(_swapping, "no swap");
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(WETH).safeTransfer(msg.sender, owed); // msg.sender is the pool mid-swap
    }

    function setPlatform(address p_) external onlyOwner {
        require(p_ != address(0), "zero");
        platform = p_;
        emit PlatformChanged(p_);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
