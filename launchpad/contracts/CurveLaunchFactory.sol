// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {CurveTokenDeployer, BondingCurveDeployer, AthVaultDeployer} from "./deployers/CurveDeployers.sol";

/// @title CurveLaunchFactory
/// @notice Launchpad-for-many (bonding-curve model). Each launch splits the new token 10% to a platform
/// AthVault (ATH-ladder seller: 40% dev / 20% $SHERIFF stakers / 40% platform) and 90% to a bonding curve
/// that graduates to a locked Uniswap pool. One shared SheriffStaking receives every launch's staker cut.
contract CurveLaunchFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant VAULT_BPS = 1000; // 10% to the ATH vault; 90% funds the curve

    address public immutable WETH;
    address public immutable v3Factory;
    address public immutable staking; // shared $SHERIFF staking contract
    CurveTokenDeployer public immutable tokenDeployer;
    BondingCurveDeployer public immutable curveDeployer;
    AthVaultDeployer public immutable vaultDeployer;

    address public platform; // 1% curve fee + 40% ATH cut recipient

    // ---- fixed, oracle-free curve terms — identical for every launch ----
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;   // 1B tokens (18 decimals)
    uint256 public constant VIRT_ETH = 0.9 ether;                 // start MC = VIRT/0.9 = 1 ETH (~$3k)
    uint256 public constant GRAD_TARGET = 4 ether;                // graduate when the curve collects 4 ETH
    uint32  public constant ANTISNIPE_SECS = 300;                 // 5-min opening window
    uint256 public constant MAX_BUY_WEI = 0.1 ether;              // per-buy cap during that window
    uint32  public constant TWAP_WINDOW = 1800;                   // 30-min TWAP for the ATH vault
    int256  public constant ATH_START_LEVEL = -887272;            // gate open (grad MC ~$89k is already >> $5k)

    struct LaunchParams {
        string name;
        string symbol;
        address dev; // project dev: gets 40% (burn/withdraw), LP fees
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
        address staking_,
        address platform_,
        address owner_,
        address tokenDeployer_,
        address curveDeployer_,
        address vaultDeployer_
    ) Ownable(owner_) {
        require(
            weth_ != address(0) && v3Factory_ != address(0) && staking_ != address(0) && platform_ != address(0)
                && tokenDeployer_ != address(0) && curveDeployer_ != address(0) && vaultDeployer_ != address(0),
            "zero"
        );
        WETH = weth_;
        v3Factory = v3Factory_;
        staking = staking_;
        platform = platform_;
        tokenDeployer = CurveTokenDeployer(tokenDeployer_);
        curveDeployer = BondingCurveDeployer(curveDeployer_);
        vaultDeployer = AthVaultDeployer(vaultDeployer_);
    }

    /// @notice Launch a token on the pad's standard, oracle-free terms: 1B supply, 1-ETH start MC,
    /// graduation at 4 ETH, 90% curve / 10% pad vault. Projects only pick name / ticker / dev.
    function launch(LaunchParams calldata p) external returns (address token, address curve, address vault) {
        if (p.dev == address(0)) revert BadValue();

        uint256 vaultAmt = (TOTAL_SUPPLY * VAULT_BPS) / 10_000; // 10%
        uint256 curveAmt = TOTAL_SUPPLY - vaultAmt; // 90%

        // 1) token minted to this factory
        token = tokenDeployer.deploy(p.name, p.symbol, TOTAL_SUPPLY, address(this));

        // 2) ATH vault (holds 10%) + bonding curve (holds 90%) — fixed terms
        vault = vaultDeployer.deploy(v3Factory, token, WETH, p.dev, platform, staking, TWAP_WINDOW, ATH_START_LEVEL);
        curve = curveDeployer.deploy(
            token, WETH, v3Factory, platform, p.dev, VIRT_ETH, curveAmt, GRAD_TARGET, ANTISNIPE_SECS, MAX_BUY_WEI
        );

        // 3) fund them
        IERC20(token).safeTransfer(vault, vaultAmt);
        IERC20(token).safeTransfer(curve, curveAmt);

        recordOf[token] = Record(token, curve, vault, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, curve, vault, p.dev, TOTAL_SUPPLY);
        // NOTE: after the curve graduates, anyone calls AthVault.activate() once to switch the vault on.
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
