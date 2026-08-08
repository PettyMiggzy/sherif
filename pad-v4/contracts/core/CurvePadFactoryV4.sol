// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";

import {DeterministicDeployer} from "./DeterministicDeployer.sol";
import {CurveV4Deployer} from "./CurveV4Deployer.sol";
import {LockVault} from "./LockVault.sol";
import {RobinV4FeeConfig} from "./RobinV4FeeConfig.sol";
import {PadToken} from "../pads/PadToken.sol";
import {RobinFeeHook} from "../hooks/RobinFeeHook.sol";
import {RobinCurveV4} from "../pads/RobinCurveV4.sol";
import {IRobinFeeHookAdmin} from "../interfaces/IRobinInterfaces.sol";

/// @title CurvePadFactoryV4 — free single-sided bonding-curve launch on Uniswap V4
/// @notice One tx, NO ETH seed: deploy the token, mine+deploy the fee hook, initialize the pool at the curve
/// top, stamp the IMMUTABLE per-pad fee config (pulled from the governed RobinV4FeeConfig), deploy the per-pad
/// RobinCurveV4 controller, and seed the token-only curve. The permanent locked LP + staking are wired at
/// graduation (see RobinCurveV4.graduate → this.onGraduated → LockVault.registerLaunch).
///
/// GOVERNANCE: every economic parameter (taxes, floor share, staking ETH slice, LP fee, curve geometry) is read
/// from `feeConfig.defaults()` and stamped immutably here — NEVER taken from the caller. So a launcher can never
/// set their own tax, and an already-launched pad's fee can never change (retuning the FeeConfig only affects
/// FUTURE launches, no factory redeploy). This is the "right the first time" rule made structural.
contract CurvePadFactoryV4 {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    address public immutable positionManager;
    address public immutable permit2;
    address public immutable stateView;
    DeterministicDeployer public immutable deployer;
    CurveV4Deployer public immutable curveDeployer; // offloads RobinCurveV4 creationCode (24KB limit)
    RobinV4FeeConfig public immutable feeConfig;
    address public immutable feeRegistry;
    LockVault public immutable lockVault;

    uint160 internal constant HOOK_FLAGS = 0x00C4;

    struct LaunchConfig {
        string name;
        string symbol;
        uint8 decimals;
        uint256 supply; // total minted to the factory
        uint256 curveSupply; // tokens SOLD via the single-sided curve
        uint256 reserveSupply; // tokens HELD BACK (never in the curve) to pair the permanent LP + feed staking
        int24 tickSpacing;
        address creator; // gets supply - curveSupply - reserveSupply
    }

    struct Launch {
        address token;
        address hook;
        address curve;
        PoolId poolId;
    }

    uint256 public launchCount;
    mapping(uint256 => Launch) public launches;
    mapping(address token => PoolId) public poolOf;
    mapping(address curve => bool) public isCurve; // authorized graduation registrars

    event CurvePadLaunched(
        uint256 indexed index, address indexed token, address indexed creator, address hook, address curve, PoolId poolId
    );

    error HookFlagsMismatch();
    error BadConfig();
    error BadGeometry();
    error NotCurve();
    error PoolAlreadyInit();

    constructor(
        address poolManager_,
        address positionManager_,
        address permit2_,
        address stateView_,
        address deployer_,
        address curveDeployer_,
        address feeConfig_,
        address feeRegistry_,
        address lockVault_
    ) {
        poolManager = IPoolManager(poolManager_);
        positionManager = positionManager_;
        permit2 = permit2_;
        stateView = stateView_;
        deployer = DeterministicDeployer(deployer_);
        curveDeployer = CurveV4Deployer(curveDeployer_);
        feeConfig = RobinV4FeeConfig(feeConfig_);
        feeRegistry = feeRegistry_;
        lockVault = LockVault(payable(lockVault_));
    }

    /// @notice Launch a free single-sided curve pad. `tokenSalt` is any CREATE2 salt (token only needs to sort
    /// above native(0), always true). `hookSalt` is mined off-chain so the hook carries flags 0x00C4.
    function launch(LaunchConfig calldata cfg, bytes32 tokenSalt, bytes32 hookSalt, bytes32 curveSalt)
        external
        returns (address token, address hook, address curve, PoolId poolId)
    {
        if (
            cfg.creator == address(0) || cfg.supply == 0 || cfg.curveSupply == 0 || cfg.reserveSupply == 0
                || cfg.curveSupply + cfg.reserveSupply > cfg.supply
        ) revert BadConfig();

        // 1) governed defaults, snapshotted + stamped immutably
        RobinV4FeeConfig.Defaults memory d = feeConfig.defaults(); // buyLpFloorShareBps + gradRewardWei validated there
        int24 ts = cfg.tickSpacing;
        if (ts <= 0 || d.startTickMag % ts != 0 || d.curveWidth % ts != 0) revert BadGeometry();
        int24 startTick = int24(d.startTickMag); // token = currency1 ⇒ launch at the high (top) tick
        int24 gradTick = startTick - int24(d.curveWidth); // ceiling (lower); startTick/gradTick are ts-aligned
        // gradTick must be strictly ABOVE minUsableTick: at == it, √grad == √minTick and _mintPermanentLp's
        // getLiquidityForAmount1(√min, √grad, …) divides by zero (reverting graduation). [D-2]
        if (startTick > TickMath.maxUsableTick(ts) || gradTick <= TickMath.minUsableTick(ts)) revert BadGeometry();
        // [HIGH-2] the reserve must be big enough that the ETH leg binds at graduation — otherwise the raise
        // would leak to the platform book, or (too small) brick graduation and trap the raise forever. Require
        // reserveSupply ≥ curveSupply·√grad/√start with a 5% margin (√grad < √start ⇒ threshold < curveSupply).
        {
            uint256 sg = uint256(TickMath.getSqrtPriceAtTick(gradTick));
            uint256 ss = uint256(TickMath.getSqrtPriceAtTick(startTick));
            if (uint256(cfg.reserveSupply) * ss * 100 < uint256(cfg.curveSupply) * sg * 105) revert BadConfig();
        }

        // 2) deploy the token (supply minted to this factory)
        token = deployer.deploy(
            tokenSalt,
            abi.encodePacked(
                type(PadToken).creationCode,
                abi.encode(cfg.name, cfg.symbol, cfg.decimals, cfg.supply, address(this))
            )
        );

        Currency currency0 = Currency.wrap(address(0)); // ETH
        Currency currency1 = Currency.wrap(token);

        // 3) deploy the flag-mined hook (token in init-code ⇒ unique address per pad)
        hook = deployer.deploy(
            hookSalt,
            abi.encodePacked(type(RobinFeeHook).creationCode, abi.encode(poolManager, address(this), feeRegistry, token))
        );
        if (uint160(hook) & 0x3FFF != HOOK_FLAGS) revert HookFlagsMismatch();
        if (RobinFeeHook(payable(hook)).REQUIRED_FLAGS() != HOOK_FLAGS) revert HookFlagsMismatch();

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: uint24(d.lpFee),
            tickSpacing: ts,
            hooks: IHooks(hook)
        });
        poolId = key.toId();

        // 4) initialize at the curve top, then bind the IMMUTABLE fee config BEFORE any liquidity/swap.
        //    [MEDIUM-3] idempotent: a same-block front-run that pre-inits the pool only survives if it landed at
        //    OUR exact start price (a byte-identical init) — any other price is hostile and we revert.
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(startTick);
        try poolManager.initialize(key, sqrtStart) returns (int24) {}
        catch {
            (uint160 sp,,,) = IStateView(stateView).getSlot0(poolId);
            if (sp != sqrtStart) revert PoolAlreadyInit();
        }
        RobinFeeHook(payable(hook)).registerPool(
            poolId,
            IRobinFeeHookAdmin.PoolFeeConfig({
                currency0: currency0,
                currency1: currency1,
                creator: cfg.creator,
                floorRecipient: address(0), // floor vault wired post-launch via hook.setFloorRecipient
                guardAdapter: address(0),
                buyTaxBps: d.buyTaxBps,
                sellTaxBps: d.sellTaxBps,
                sellFloorShareBps: d.sellFloorShareBps,
                guardWindow: 0,
                quoteIsStock: false
            })
        );

        // 5) deploy the per-pad curve controller (creationCode offloaded to CurveV4Deployer), hand it the curve
        //    tokens, and seed the single-sided position
        curve = curveDeployer.deploy(
            curveSalt,
            abi.encode(
                address(poolManager),
                positionManager,
                permit2,
                stateView,
                address(lockVault),
                address(this),
                feeRegistry,
                currency0,
                currency1,
                uint24(d.lpFee),
                ts,
                hook,
                startTick,
                gradTick,
                d.buyLpFloorShareBps,
                d.gradRewardWei,
                cfg.creator
            )
        );
        isCurve[curve] = true;
        IERC20(token).safeTransfer(curve, cfg.curveSupply); // the SOLD portion → seeded into the curve
        RobinCurveV4(payable(curve)).seed();
        IERC20(token).safeTransfer(curve, cfg.reserveSupply); // the HELD reserve → pairs the permanent LP + staking

        // 6) send the non-curve, non-reserve remainder to the creator
        uint256 rem = IERC20(token).balanceOf(address(this));
        if (rem > 0) IERC20(token).safeTransfer(cfg.creator, rem);

        uint256 index = launchCount++;
        launches[index] = Launch({token: token, hook: hook, curve: curve, poolId: poolId});
        poolOf[token] = poolId;
        emit CurvePadLaunched(index, token, cfg.creator, hook, curve, poolId);
    }

    /// @notice Called by a graduating curve controller to register its permanent locked LP. LockVault accepts
    /// registerLaunch only from this factory, so routing through here keeps the vault's sole-registrar invariant.
    function onGraduated(uint256 lpTokenId, Currency c0, Currency c1, address staking) external {
        if (!isCurve[msg.sender]) revert NotCurve();
        lockVault.registerLaunch(lpTokenId, c0, c1, staking);
    }
}
