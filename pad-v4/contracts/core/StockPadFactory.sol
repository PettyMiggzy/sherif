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
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
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
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IPositionManagerMinimal public immutable positionManager;
    IPermit2Minimal public immutable permit2;
    DeterministicDeployer public immutable deployer;
    address public immutable feeRegistry;
    LockVault public immutable lockVault;

    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    uint160 internal constant HOOK_FLAGS = 0x00CC;
    uint48 internal constant MAX_UINT48 = type(uint48).max;
    /// [H-2] A corporate-action window is hours, not years. `guardWindow` was an unbounded uint32 stamped
    /// immutably into the hook, so a single call could cover ~136 years of frozen trading.
    uint32 public constant MAX_GUARD_WINDOW = 7 days;

    /// [H-2] The platform's known STOCK_REGISTRY, pinned HERE rather than named per-launch. The contract's own
    /// securities-gate claim used to rest on StockQuoteAdapter's constructor check — but that constructor takes
    /// `expectedRegistry` as an ARGUMENT, so it proves only that the stock and the registry agree with each
    /// other, not that the registry is the platform's. With no registry immutable and no adapter allow-list on
    /// this factory, deploying MockStockRegistry → MockStock(thatRegistry) → StockQuoteAdapter(both) from any
    /// account produced a pad carrying quoteIsStock == true that was on-chain indistinguishable from a genuine
    /// one. Pinning the registry closes that: a stock not governed by THIS registry cannot be launched.
    address public immutable stockRegistry;

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
        uint32 guardWindow; // corporate-action curb window (seconds), <= MAX_GUARD_WINDOW
        address stock; // [H-2] the tokenized stock to quote against. The ADAPTER is derived from it and this
            // factory's pinned registry, never supplied: a launcher-chosen adapter is a freeze primitive. The
            // curb reads scheduledEffectiveAt() on every swap, above the direction check and above the
            // sender == address(this) exemption, so it halts buys and sells alike — and try/catch defends only
            // against an adapter that REVERTS. One that simply lies, returning a plausible non-zero effectiveAt
            // forever, passes cleanly and freezes the pad exactly as its author intended.
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
    error PoolAlreadyInit();

    constructor(
        address poolManager_,
        address positionManager_,
        address permit2_,
        address deployer_,
        address feeRegistry_,
        address lockVault_,
        address stockRegistry_
    ) {
        if (stockRegistry_ == address(0)) revert BadConfig();
        stockRegistry = stockRegistry_;
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManagerMinimal(positionManager_);
        permit2 = IPermit2Minimal(permit2_);
        deployer = DeterministicDeployer(deployer_);
        feeRegistry = feeRegistry_;
        lockVault = LockVault(payable(lockVault_));
    }

    /// @notice Launch a stock-quoted pad. The caller must have approved this factory to pull `stockSeed`
    /// of the stock. `tokenSalt` must be mined so the token address sorts ABOVE the stock (quote=currency0).
    /// [H-4] Only part of `stockSeed` normally reaches the pool — the seed position binds on one leg, so the
    /// other is over-supplied by construction. The unused stock is returned to the CALLER (who paid it); the
    /// unused pad token goes to `cfg.creator` (the factory minted it). Payer and creator may differ.
    function launch(LaunchConfig calldata cfg, bytes32 tokenSalt, bytes32 hookSalt)
        external
        returns (address token, address hook, PoolId poolId, uint256 lpTokenId)
    {
        if (cfg.fee & DYNAMIC_FEE_FLAG != 0) revert DynamicFeeNotAllowed();
        if (cfg.creator == address(0) || cfg.stock == address(0)) revert BadConfig();
        if (cfg.supply == 0 || cfg.lpTokenAmount == 0 || cfg.stockSeed == 0) revert BadConfig();
        if (cfg.lpTokenAmount > cfg.supply) revert BadConfig();
        if (cfg.guardWindow > MAX_GUARD_WINDOW) revert BadConfig(); // [H-2] hours, not years

        address stock = cfg.stock; // quote
        // [H-2] DERIVE the curb adapter from (stock, pinned registry) instead of accepting one. The adapter's
        // constructor requires stock.ACCESS_CONTROLLED_REGISTRY() == the registry it is handed, and the registry
        // handed here is THIS factory's — so a stock the platform's registry does not govern cannot be launched
        // at all, and no launcher-authored contract ever sits on the curb path. The deployer adopts a
        // byte-identical existing deployment, so relaunching against the same stock reuses the same adapter.
        address adapter = deployer.deploy(
            keccak256(abi.encode(stock, stockRegistry)),
            abi.encodePacked(type(StockQuoteAdapter).creationCode, abi.encode(stock, stockRegistry))
        );

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

        // [audit] idempotent init: a same-block front-run that pre-inits the deterministic PoolKey only survives if
        // it landed at OUR exact price; any other price is hostile and we revert (else a griefer could brick the
        // launch). Mirrors CurvePadFactoryV4's [MEDIUM-3].
        try poolManager.initialize(key, cfg.sqrtPriceX96) returns (int24) {}
        catch {
            (uint160 sp,,,) = poolManager.getSlot0(poolId);
            if (sp != cfg.sqrtPriceX96) revert PoolAlreadyInit();
        }
        RobinFeeHook(payable(hook)).registerPool(
            poolId,
            IRobinFeeHookAdmin.PoolFeeConfig({
                currency0: currency0,
                currency1: currency1,
                creator: cfg.creator,
                floorRecipient: cfg.floorRecipient,
                guardAdapter: adapter, // the stock curb source — derived, never launcher-supplied [H-2]
                buyTaxBps: cfg.buyTaxBps,
                sellTaxBps: cfg.sellTaxBps,
                sellFloorShareBps: cfg.sellFloorShareBps,
                buyBufferShareBps: 0, // no curve buffer on the stock pad
                referralShareBps: 0, // no referral on the stock pad
                guardWindow: cfg.guardWindow,
                quoteIsStock: true
            })
        );

        // 3) pull the stock seed from the caller, then mint the seed LP (both ERC20s) to the LockVault.
        // [H-4] Snapshot first. The refund below must return what THIS launch left over, not the factory's whole
        // balance of the asset — otherwise stock parked here by any other means leaves with the next launcher.
        uint256 stockBefore = IERC20(stock).balanceOf(address(this));
        IERC20(stock).safeTransferFrom(msg.sender, address(this), cfg.stockSeed);
        lpTokenId = _mintSeedLp(key, cfg, stock, token);

        // 4) register the lock, send the token remainder to the creator, return any unused stock TO THE PAYER
        lockVault.registerLaunch(lpTokenId, currency0, currency1, cfg.stakingRecipient);
        // the token was minted to this factory, so its remainder is the creator's by construction
        uint256 tokenRemainder = IERC20(token).balanceOf(address(this));
        if (tokenRemainder > 0) IERC20(token).safeTransfer(cfg.creator, tokenRemainder);
        // [H-4] The stock came from msg.sender — `launch` is not payable and the caller must have approved this
        // factory to pull `stockSeed`, so payer and creator are two explicitly-modelled, distinct roles here.
        // Refunding the stock to cfg.creator sent the payer's money to someone else. It is not a corner case:
        // _mintSeedLp sizes the position with getLiquidityForAmounts, which binds on ONE leg only, so the other
        // leg is over-supplied BY CONSTRUCTION and there is almost always a remainder. Measured with
        // lpTokenAmount 1e20 and stockSeed 1e23 at 1:1, only 100e18 reached the pool and 99,900e18 — 99.9% of
        // the payer's balance — went to the creator, silently and irreversibly.
        uint256 stockRemainder = IERC20(stock).balanceOf(address(this)) - stockBefore;
        if (stockRemainder > 0) IERC20(stock).safeTransfer(msg.sender, stockRemainder);

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
