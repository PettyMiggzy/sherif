// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchTokenDeployer, CurvePoolDeployer} from "./deployers/CurveDeployers.sol";

interface ICurvePool {
    function pool() external view returns (address);
    function seed() external;
}

/// @title CurvePadFactory — DEX-day-one launchpad (the NOXA-style model, plus the Bond)
/// @notice One `launch()` call: deploys a clean anti-snipe token, creates a REAL Uniswap v3 pool, seeds the
/// token as a single-sided concentrated "curve" position, and enables trading — so the token is on Uniswap +
/// DexScreener from block one. Buyers walk the price up the curve; at the top anyone calls `graduate()` on the
/// CurvePool to post the Bond (Sherwood floor-LP + Bounty + Ambush). The platform funds nothing — the token
/// seeds its own liquidity; buyers bring the ETH. 1% pool-fee tier; the token carries an auto-expiring,
/// buy-side-only, sells-never-blocked opening guard vs first-block snipers.
contract CurvePadFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant AMBUSH_BPS = 2500; // 25% reserved for the Bond's Ambush; 75% is the curve

    address public immutable WETH;
    address public immutable v3Factory;
    LaunchTokenDeployer public immutable tokenDeployer;
    CurvePoolDeployer public immutable curveDeployer;
    address public immutable bondDeployer;

    address public platform;

    // ---- fixed terms (identical for every launch) ----
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B
    int24 public constant START_TICK_MAG = 207200; // start price ~1e-9 WETH/token (~1-ETH start MC); sign set by ordering
    int24 public constant CURVE_WIDTH = 35800; // ~36x span from start to graduation

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

    event Launched(address indexed token, address indexed curve, address indexed pool, address dev);
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

    /// @notice One transaction: token + real Uniswap pool + seeded curve + trading on. DEX + DexScreener day one.
    function launch(LaunchParams calldata p) external returns (address token, address curve, address pool) {
        if (p.dev == address(0)) revert BadValue();

        uint256 ambushAmt = (TOTAL_SUPPLY * AMBUSH_BPS) / 10_000; // 25% -> Bond Ambush
        uint256 curveAmt = TOTAL_SUPPLY - ambushAmt; // 75% -> the curve

        // 1) clean token with an auto-expiring opening guard (mints supply to this factory)
        LaunchToken.GuardConfig memory g = LaunchToken.GuardConfig({
            deadSecs: 2, // first ~2s: buys revert (kills the first-block bot)
            phase1Secs: 60,
            antiSnipeSecs: 300, // guard fully gone after 5 min
            maxTxBps1: 50, // phase 1: max 0.5% buy
            maxWalletBps1: 100, // phase 1: max 1% wallet
            maxTxBps2: 100, // phase 2: max 1% buy
            maxWalletBps2: 200, // phase 2: max 2% wallet
            cooldownSecs: 2
        });
        token = tokenDeployer.deploy(p.name, p.symbol, TOTAL_SUPPLY, address(this), g);

        // 2) the curve = a REAL Uniswap v3 pool; start tick sign depends on token/WETH ordering (token stays cheap)
        int24 startTick = token < WETH ? -START_TICK_MAG : START_TICK_MAG;
        curve = curveDeployer.deploy(
            token, WETH, v3Factory, platform, p.dev, bondDeployer, curveAmt, ambushAmt, startTick, CURVE_WIDTH
        );
        pool = ICurvePool(curve).pool();

        // 3) fund the curve with the whole supply, turn trading on (exempts pool + curve), then seed the curve
        IERC20(token).safeTransfer(curve, TOTAL_SUPPLY); // factory is exempt -> allowed pre-trading
        LaunchToken(token).enableTrading(pool, curve, uint64(block.timestamp));
        ICurvePool(curve).seed(); // mints the single-sided position -> live + tradeable + on DexScreener

        recordOf[token] = Record(token, curve, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, curve, pool, p.dev);
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
