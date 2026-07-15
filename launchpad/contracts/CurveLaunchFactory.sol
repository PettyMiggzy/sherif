// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {CurveTokenDeployer, BondingCurveDeployer, OtcVaultDeployer} from "./deployers/CurveDeployers.sol";

/// @title CurveLaunchFactory
/// @notice Launchpad-for-many (bonding-curve model). Each launch splits the token 20% to an OtcVault (a
/// burn-$SHERIFF-for-access OTC desk that opens at ~$10k MC; OTC ETH -> platform) and 80% to a bonding curve
/// that graduates to a locked Uniswap pool. Buy fee 1% -> platform; sell fee 1% -> project dev; LP fees -> platform.
contract CurveLaunchFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant VAULT_BPS = 2000; // 20% to the OTC vault; 80% funds the curve

    address public immutable WETH;
    address public immutable v3Factory;
    address public immutable sheriff; // $SHERIFF token — burned for OTC access
    CurveTokenDeployer public immutable tokenDeployer;
    BondingCurveDeployer public immutable curveDeployer;
    OtcVaultDeployer public immutable vaultDeployer;

    address public platform; // buy fee + LP fee + OTC ETH recipient

    // ---- fixed, oracle-free terms — identical for every launch ----
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;   // 1B tokens (18 decimals)
    uint256 public constant VIRT_ETH = 0.8 ether;                 // start MC = VIRT/0.8 = 1 ETH (~$3k)
    uint256 public constant GRAD_TARGET = 4 ether;                // graduate when the curve collects 4 ETH
    uint32  public constant ANTISNIPE_SECS = 300;                 // 5-min opening window
    uint256 public constant MAX_BUY_WEI = 0.1 ether;              // per-buy cap during that window
    uint32  public constant TWAP_WINDOW = 1800;                   // 30-min TWAP for the OTC open trigger
    // OTC opens + sells at ~$10k MC (oracle-free, in ETH at deploy): price = 10k-in-ETH / totalSupply.
    // ~$10k ≈ 3.33 ETH MC -> otcPrice = 3.33e18 * 1e18 / 1e27 = 3.33e9 WETH-wei per 1e18 token.
    uint256 public constant OTC_PRICE = 3_330_000_000;            // WETH-wei per 1e18 token (~$10k MC)
    uint256 public constant OTC_BURN_RATIO = 100 ether;          // project tokens (1e18) unlocked per 1 $SHERIFF burned (tunable)

    struct LaunchParams {
        string name;
        string symbol;
        address dev; // project dev: gets the 1% sell fee (burn or collect)
    }

    struct Record {
        address token;
        address curve;
        address vault;
        address dev;
        uint256 at;
    }

    mapping(address => Record) public recordOf;
    address[] public allTokens;

    error BadValue();

    event Launched(address indexed token, address indexed curve, address indexed vault, address dev, uint256 supply);
    event PlatformChanged(address platform);

    constructor(
        address weth_,
        address v3Factory_,
        address sheriff_,
        address platform_,
        address owner_,
        address tokenDeployer_,
        address curveDeployer_,
        address vaultDeployer_
    ) Ownable(owner_) {
        require(
            weth_ != address(0) && v3Factory_ != address(0) && sheriff_ != address(0) && platform_ != address(0)
                && tokenDeployer_ != address(0) && curveDeployer_ != address(0) && vaultDeployer_ != address(0),
            "zero"
        );
        WETH = weth_;
        v3Factory = v3Factory_;
        sheriff = sheriff_;
        platform = platform_;
        tokenDeployer = CurveTokenDeployer(tokenDeployer_);
        curveDeployer = BondingCurveDeployer(curveDeployer_);
        vaultDeployer = OtcVaultDeployer(vaultDeployer_);
    }

    /// @notice Launch a token on the pad's standard, oracle-free terms: 1B supply, 1-ETH start MC,
    /// graduation at 4 ETH, 80% curve / 20% OTC vault. Projects only pick name / ticker / dev.
    function launch(LaunchParams calldata p) external returns (address token, address curve, address vault) {
        if (p.dev == address(0)) revert BadValue();

        uint256 vaultAmt = (TOTAL_SUPPLY * VAULT_BPS) / 10_000; // 20%
        uint256 curveAmt = TOTAL_SUPPLY - vaultAmt; // 80%

        // 1) token minted to this factory
        token = tokenDeployer.deploy(p.name, p.symbol, TOTAL_SUPPLY, address(this));

        // 2) OTC vault (holds 20%) + bonding curve (holds 80%) — fixed terms
        vault = vaultDeployer.deploy(v3Factory, token, WETH, sheriff, platform, TWAP_WINDOW, OTC_PRICE, OTC_BURN_RATIO);
        curve = curveDeployer.deploy(
            token, WETH, v3Factory, platform, p.dev, VIRT_ETH, curveAmt, GRAD_TARGET, ANTISNIPE_SECS, MAX_BUY_WEI
        );

        // 3) fund them
        IERC20(token).safeTransfer(vault, vaultAmt);
        IERC20(token).safeTransfer(curve, curveAmt);

        recordOf[token] = Record(token, curve, vault, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, curve, vault, p.dev, TOTAL_SUPPLY);
        // NOTE: after the curve graduates, anyone calls OtcVault.activate() once to bind the pool.
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
