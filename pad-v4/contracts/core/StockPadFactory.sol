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
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {DeterministicDeployer} from "./DeterministicDeployer.sol";
import {LockVault} from "./LockVault.sol";
import {PadToken} from "../pads/PadToken.sol";
import {RobinFeeHook} from "../hooks/RobinFeeHook.sol";
import {StockQuoteAdapter} from "../adapters/StockQuoteAdapter.sol";
import {IRobinFeeHookAdmin} from "../interfaces/IRobinInterfaces.sol";
import {IPositionManagerMinimal} from "../interfaces/IPositionManagerMinimal.sol";
import {IPermit2Minimal} from "../interfaces/IPermit2Minimal.sol";

/// @title StockPadFactory — RobinBlue: launch a token paired against a tokenized STOCK quote
/// @notice Sibling to the native-ETH PadFactory. The quote is an ERC20 stock (18-dec), so:
///   • the pool is currency0 = STOCK (quote), currency1 = TOKEN — the launcher mines `tokenSalt` so the
///     token address sorts ABOVE the stock, keeping the hook's quote==currency0 / zeroForOne==BUY model.
///   • the seed LP is two ERC20s (stock + token), both pulled via Permit2 (no native value).
///   • the hook is registered with quoteIsStock=true + the (pre-gated) StockQuoteAdapter as its curb.
///
/// SECURITIES / LEGAL GATE: the StockQuoteAdapter's ctor already requires the stock's registry to match
/// the platform's known STOCK_REGISTRY, so only registry-governed stocks can be paired. Tokenized-stock
/// pads are a regulated concern — this factory is the on-chain half; KYC/geo gating and the issuer
/// allow-list (issuers who contractually won't `adminBurn` pool addresses, see the D1/D3 disclosures on
/// StockQuoteAdapter) are launch gates the operator MUST satisfy off-chain before using this.
///
/// NOTE: this path is NOT yet fork-tested against a live Robinhood Stock Token and has not had its own
/// security audit — treat as unaudited until both are done, exactly as the ETH pad required.
contract StockPadFactory {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    IPositionManagerMinimal public immutable positionManager;
    IPermit2Minimal public immutable permit2;
    DeterministicDeployer public immutable deployer;
    address public immutable feeRegistry;
    LockVault public immutable lockVault;

    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    uint160 internal constant HOOK_FLAGS = 0x00C4;
    uint48 internal constant MAX_UINT48 = type(uint48).max;

    struct LaunchConfig {
        string name;
        string symbol;
        uint8 decimals;
        uint256 supply;
        uint256 lpTokenAmount; // token seeded into the LP
        uint256 stockSeed; // stock (quote) seeded into the LP — pulled from the caller
        uint160 sqrtPriceX96;
        int24 tickSpacing;
        uint24 fee; // STATIC lp fee
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 sellFloorShareBps;
        uint32 guardWindow; // corporate-action curb window (seconds)
        address adapter; // a pre-gated StockQuoteAdapter (its ctor already matched the registry)
        address creator;
        address floorRecipient;
        address stakingRecipient;
    }

    struct Launch {
        address token;
        address hook;
        PoolId poolId;
        uint256 lpTokenId;
    }

    uint256 public launchCount;
    mapping(uint256 => Launch) public launches;
    mapping(address token => PoolId) public poolOf;

    event StockPadLaunched(
        uint256 indexed index, address indexed token, address indexed stock, address hook, PoolId poolId, uint256 lpTokenId
    );

    error DynamicFeeNotAllowed();
    error HookFlagsMismatch();
    error TokenMisordered();
    error BadConfig();

    constructor(
        address poolManager_,
        address positionManager_,
        address permit2_,
        address deployer_,
        address feeRegistry_,
        address lockVault_
    ) {
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManagerMinimal(positionManager_);
        permit2 = IPermit2Minimal(permit2_);
        deployer = DeterministicDeployer(deployer_);
        feeRegistry = feeRegistry_;
        lockVault = LockVault(payable(lockVault_));
    }

    /// @notice Launch a stock-quoted pad. The caller must have approved this factory to pull `stockSeed`
    /// of the stock. `tokenSalt` must be mined so the token address sorts ABOVE the stock (quote=currency0).
    function launch(LaunchConfig calldata cfg, bytes32 tokenSalt, bytes32 hookSalt)
        external
        returns (address token, address hook, PoolId poolId, uint256 lpTokenId)
    {
        if (cfg.fee & DYNAMIC_FEE_FLAG != 0) revert DynamicFeeNotAllowed();
        if (cfg.creator == address(0) || cfg.adapter == address(0)) revert BadConfig();
        if (cfg.supply == 0 || cfg.lpTokenAmount == 0 || cfg.stockSeed == 0) revert BadConfig();
        if (cfg.lpTokenAmount > cfg.supply) revert BadConfig();

        address stock = StockQuoteAdapter(cfg.adapter).stock(); // quote

        // 1) deploy the token (supply to this factory), require it sorts ABOVE the stock ⇒ pad = currency1
        token = deployer.deploy(
            tokenSalt,
            abi.encodePacked(
                type(PadToken).creationCode,
                abi.encode(cfg.name, cfg.symbol, cfg.decimals, cfg.supply, address(this))
            )
        );
        if (token <= stock) revert TokenMisordered(); // currency0 = stock < currency1 = token

        Currency currency0 = Currency.wrap(stock);
        Currency currency1 = Currency.wrap(token);

        // 2) deploy the flag-mined hook (token in init-code ⇒ unique address)
        hook = deployer.deploy(
            hookSalt,
            abi.encodePacked(type(RobinFeeHook).creationCode, abi.encode(poolManager, address(this), feeRegistry, token))
        );
        if (uint160(hook) & 0x3FFF != HOOK_FLAGS) revert HookFlagsMismatch();
        if (RobinFeeHook(payable(hook)).REQUIRED_FLAGS() != HOOK_FLAGS) revert HookFlagsMismatch();

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: cfg.fee,
            tickSpacing: cfg.tickSpacing,
            hooks: IHooks(hook)
        });
        poolId = key.toId();

        poolManager.initialize(key, cfg.sqrtPriceX96);
        RobinFeeHook(payable(hook)).registerPool(
            poolId,
            IRobinFeeHookAdmin.PoolFeeConfig({
                currency0: currency0,
                currency1: currency1,
                creator: cfg.creator,
                floorRecipient: cfg.floorRecipient,
                guardAdapter: cfg.adapter, // the stock curb source
                buyTaxBps: cfg.buyTaxBps,
                sellTaxBps: cfg.sellTaxBps,
                sellFloorShareBps: cfg.sellFloorShareBps,
                guardWindow: cfg.guardWindow,
                quoteIsStock: true
            })
        );

        // 3) pull the stock seed from the caller, then mint the seed LP (both ERC20s) to the LockVault
        IERC20(stock).safeTransferFrom(msg.sender, address(this), cfg.stockSeed);
        lpTokenId = _mintSeedLp(key, cfg, stock, token);

        // 4) register the lock, send the token remainder to the creator, return any unused stock
        lockVault.registerLaunch(lpTokenId, currency0, currency1, cfg.stakingRecipient, 0); // 0 => all LP fees → platform
        uint256 tokenRemainder = IERC20(token).balanceOf(address(this));
        if (tokenRemainder > 0) IERC20(token).safeTransfer(cfg.creator, tokenRemainder);
        uint256 stockRemainder = IERC20(stock).balanceOf(address(this));
        if (stockRemainder > 0) IERC20(stock).safeTransfer(cfg.creator, stockRemainder);

        uint256 index = launchCount++;
        launches[index] = Launch({token: token, hook: hook, poolId: poolId, lpTokenId: lpTokenId});
        poolOf[token] = poolId;
        emit StockPadLaunched(index, token, stock, hook, poolId, lpTokenId);
    }

    function _mintSeedLp(PoolKey memory key, LaunchConfig calldata cfg, address stock, address token)
        internal
        returns (uint256 tokenId)
    {
        int24 tickLower = TickMath.minUsableTick(cfg.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(cfg.tickSpacing);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            cfg.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            cfg.stockSeed, // amount0 = stock (currency0)
            cfg.lpTokenAmount // amount1 = token (currency1)
        );

        // approve Permit2 → PositionManager for BOTH currencies
        IERC20(stock).forceApprove(address(permit2), cfg.stockSeed);
        permit2.approve(stock, address(positionManager), uint160(cfg.stockSeed), MAX_UINT48);
        IERC20(token).forceApprove(address(permit2), cfg.lpTokenAmount);
        permit2.approve(token, address(positionManager), uint160(cfg.lpTokenAmount), MAX_UINT48);

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, tickLower, tickUpper, uint256(liquidity), uint128(cfg.stockSeed), uint128(cfg.lpTokenAmount), address(lockVault), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1); // settle both ERC20s (factory pays via Permit2)

        uint256 before = positionManager.nextTokenId();
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        tokenId = before;

        // revoke residual approvals (mint pulls only what's needed)
        permit2.approve(stock, address(positionManager), 0, 0);
        permit2.approve(token, address(positionManager), 0, 0);
        IERC20(stock).forceApprove(address(permit2), 0);
        IERC20(token).forceApprove(address(permit2), 0);
    }
}
