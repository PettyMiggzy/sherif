// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
import {IRobinFeeHookAdmin} from "../interfaces/IRobinInterfaces.sol";
import {IPositionManagerMinimal} from "../interfaces/IPositionManagerMinimal.sol";
import {IPermit2Minimal} from "../interfaces/IPermit2Minimal.sol";
import {PadBrand} from "./PadBrand.sol";

/// @title PadFactory — immutable one-tx launch orchestrator (Feature 1: the ETH pad)
/// @notice Atomically, in one legacy type-0 tx:
///   1. CREATE2-deploys the PadToken (supply minted here)
///   2. CREATE2-deploys the RobinFeeHook at a flag-mined address (0x…C4) and cross-checks it
///   3. initializes the V4 pool with a STATIC lp fee (never the dynamic flag) [A2]
///   4. binds the immutable fee config on the hook (registerPool) BEFORE any swap [G2]
///   5. mints the seed LP full-range position with recipient = LockVault (locked forever) [E1]
///   6. registers the lock, sends the non-LP token remainder to the creator, refunds ETH dust
/// The factory has ZERO ongoing power over funds: no owner-movable knob lives here. The only
/// system-wide mutable is FeeWalletRegistry.platformFeeWallet (timelocked, read at claim time).
contract PadFactory {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;
    IPositionManagerMinimal public immutable positionManager;
    IPermit2Minimal public immutable permit2;
    DeterministicDeployer public immutable deployer;
    address public immutable feeRegistry;
    LockVault public immutable lockVault;

    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    uint160 internal constant HOOK_FLAGS = 0x00CC;
    // [M-3] Governed ceilings — the same policy the curve path (RobinV4FeeConfig) enforces, so a PadFactory launcher
    // cannot carry a heavier tax than a governed pad. The hook's own MAX_TAX_BPS is looser (3%/side) and does NOT cap
    // the floor share; these bind here. floor/staking RECIPIENTS stay launcher-chosen (a creator's own pools) — that
    // is inherent to "the creator earns the sell tax", and is documented rather than gated.
    uint16 internal constant MAX_TAX_BPS = 200; // ≤2% per side
    uint16 internal constant MAX_FLOOR_SHARE_BPS = 5000; // ≤50% of the sell tax to the floor (rest → creator)
    uint24 internal constant MAX_LP_FEE = 10_000; // ≤1% static LP fee (matches RobinV4FeeConfig.MAX_LP_FEE)
    uint48 internal constant MAX_UINT48 = type(uint48).max;

    struct LaunchConfig {
        string name;
        string symbol;
        uint8 decimals;
        uint256 supply; // total minted to the factory
        uint256 lpTokenAmount; // portion seeded into the LP; remainder → creator
        uint160 sqrtPriceX96; // initial pool price
        int24 tickSpacing;
        uint24 fee; // STATIC lp fee (must NOT carry the dynamic-fee flag)
        uint16 buyTaxBps; // trade tax on buys → platform ([L-5] bps of the quote INPUT — money-side fee-on-input)
        uint16 sellTaxBps; // trade tax on sells → creator + floor (bps of quote output)
        uint16 sellFloorShareBps; // share of the sell tax carved to the floor
        address creator;
        address floorRecipient; // floor carve destination; 0 => it parks in the hook
        address stakingRecipient; // token-side LP fee destination (the pad's staking pool); 0 => platform
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

    event PadLaunched(
        uint256 indexed index,
        address indexed token,
        address indexed creator,
        address hook,
        PoolId poolId,
        uint256 lpTokenId
    );

    error DynamicFeeNotAllowed();
    error HookFlagsMismatch();
    error TokenMisordered();
    error BadConfig();
    error AlreadyLaunched();
    error RefundFailed();
    error PoolAlreadyInit();

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

    /// @notice Launch an ETH-quoted pad. `msg.value` is the native ETH seed liquidity.
    /// @param cfg launch parameters
    /// @param tokenSalt CREATE2 salt for the token (address only needs to sort > native(0), always true)
    /// @param hookSalt CREATE2 salt mined so the hook address carries flags 0x00CC
    function launch(LaunchConfig calldata cfg, bytes32 tokenSalt, bytes32 hookSalt)
        external
        payable
        returns (address token, address hook, PoolId poolId, uint256 lpTokenId)
    {
        if (cfg.fee & DYNAMIC_FEE_FLAG != 0) revert DynamicFeeNotAllowed(); // [A2] static fee only
        if (cfg.creator == address(0) || cfg.supply == 0 || cfg.lpTokenAmount == 0) revert BadConfig();
        if (cfg.lpTokenAmount > cfg.supply) revert BadConfig();
        // [M-3] governed ceilings — a PadFactory launcher cannot exceed the curve path's tax policy
        if (cfg.buyTaxBps > MAX_TAX_BPS || cfg.sellTaxBps > MAX_TAX_BPS) revert BadConfig();
        if (cfg.sellFloorShareBps > MAX_FLOOR_SHARE_BPS) revert BadConfig();
        if (cfg.fee > MAX_LP_FEE) revert BadConfig();

        // 1) deploy the token (supply minted to this factory)
        // [SALT BINDING] The caller's mined salt is folded together with the WHOLE config before it reaches
        // the deployer, so the token address depends on every field of the launch and not just the salt.
        //
        // Without this, `tokenSalt` reached DeterministicDeployer raw while the token's init-code covered only
        // (name, symbol, decimals, supply, factory). `cfg.creator`, `curveSupply`, `reserveSupply`,
        // `tickSpacing` and `startTickMag` were in NEITHER — so anyone who saw a salt could replay the launch
        // with those fields changed and land on the same address. `launch` is permissionless, `requireBrand`
        // below makes mining compulsory so every salt in this system is a mined one sitting in public
        // calldata, a reverted launch leaves that calldata in block history forever, and PresaleVault reveals
        // its salts on-chain by design. The deployer ADOPTS an existing deployment rather than reverting,
        // which made the replay smoother still.
        //
        // Binding the config rather than msg.sender is deliberate: the presale vault is the caller on that
        // path, and its address is not knowable when the creator mines. Folding the config keeps mining
        // reproducible for whoever legitimately submits it, while any substitution at all — a different
        // creator, a different supply split, a different launch price — lands somewhere else entirely.
        token = deployer.deploy(
            keccak256(abi.encode(cfg, tokenSalt)),
            abi.encodePacked(
                type(PadToken).creationCode,
                abi.encode(cfg.name, cfg.symbol, cfg.decimals, cfg.supply, address(this))
            )
        );

        // [brand] every Robin pad token address ends in `1ab5` — the caller mines `tokenSalt` for it
        // (scripts/mine.js mineTokenSalt). Checked before ANY pool/LP state is written, so an unmined
        // salt fails loudly and cannot half-create a pad. See contracts/core/PadBrand.sol.
        PadBrand.requireBrand(token);

        // native ETH is currency0 (address 0, sorts lowest); the token must be currency1
        Currency currency0 = Currency.wrap(address(0));
        Currency currency1 = Currency.wrap(token);
        if (token <= address(0)) revert TokenMisordered(); // defensive; any address > 0
        // [M-27] launch() is permissionless and NOTHING upstream is keyed on the whole PoolKey: the deterministic
        // deployer ADOPTS a byte-identical pre-deploy rather than reverting, the token init-code carries only
        // (name, symbol, decimals, supply, factory), the hook init-code only (poolManager, factory, registry,
        // token), and registerPool rejects only a repeat of the SAME PoolId. So the same salts with a different
        // fee or tickSpacing produced a SECOND live pool over an already-launched pad token.
        if (PoolId.unwrap(poolOf[token]) != bytes32(0)) revert AlreadyLaunched();

        // 2) deploy the hook at its mined, flag-correct address
        // token is part of the hook's init-code so each pad's hook address is unique (no second-launch
        // collision). token was deployed just above, so its address is known here. [audit]
        hook = deployer.deploy(
            hookSalt,
            abi.encodePacked(type(RobinFeeHook).creationCode, abi.encode(poolManager, address(this), feeRegistry, token))
        );
        // cross-check both the mined flags and the hook's own declared REQUIRED_FLAGS [G1]
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
        // [M-27] Claim the token HERE, at the earliest point poolId exists — not at the end of launch(). The
        // guard above only closes the door if the write happens before any external call this function makes,
        // otherwise a re-entrant creator callback could slip a second launch past it inside the same tx.
        poolOf[token] = poolId;

        // 3) initialize the pool (static fee) — factory calls directly, no PoolInitializer [G2].
        //    [audit] idempotent: a same-block front-run that pre-inits the pool only survives if it landed at OUR
        //    exact price (byte-identical init) — any other price is hostile and we revert; otherwise a griefer could
        //    pre-initialize the deterministic PoolKey and brick the launch. Mirrors CurvePadFactoryV4's [MEDIUM-3].
        try poolManager.initialize(key, cfg.sqrtPriceX96) returns (int24) {}
        catch {
            (uint160 sp,,,) = poolManager.getSlot0(poolId);
            if (sp != cfg.sqrtPriceX96) revert PoolAlreadyInit();
        }

        // 4) bind immutable fee config BEFORE any swap [G2]
        RobinFeeHook(payable(hook)).registerPool(
            poolId,
            IRobinFeeHookAdmin.PoolFeeConfig({
                currency0: currency0,
                currency1: currency1,
                creator: cfg.creator,
                floorRecipient: cfg.floorRecipient, // 0 => floor carve parks in the hook until a vault is wired
                guardAdapter: address(0), // ETH pad: no stock curb
                buyTaxBps: cfg.buyTaxBps,
                sellTaxBps: cfg.sellTaxBps,
                sellFloorShareBps: cfg.sellFloorShareBps,
                buyBufferShareBps: 0, // no curve buffer on the plain ETH pad
                referralShareBps: 0, // no referral on the plain ETH pad
                guardWindow: 0,
                quoteIsStock: false
            })
        );

        // 5) mint the seed LP full-range position, recipient = LockVault (locked forever) [E1]
        lpTokenId = _mintSeedLp(key, cfg, currency0, currency1);

        // 6) register the lock, distribute the remainder, refund ETH dust
        lockVault.registerLaunch(lpTokenId, currency0, currency1, cfg.stakingRecipient);

        // [audit M1] Send the creator whatever token the factory actually still holds — the seed mint
        // consumes min(liquidity0, liquidity1) worth, so when the ETH leg binds it pulls LESS than
        // lpTokenAmount and the surplus stays here. Using the live balance (not supply - lpTokenAmount)
        // ensures no token is ever silently stranded in the factory.
        uint256 remainder = IERC20(token).balanceOf(address(this));
        if (remainder > 0) IERC20(token).transfer(cfg.creator, remainder);

        uint256 dust = address(this).balance;
        if (dust > 0) {
            (bool ok,) = payable(cfg.creator).call{value: dust}("");
            if (!ok) revert RefundFailed();
        }

        uint256 index = launchCount++;
        launches[index] = Launch({token: token, hook: hook, poolId: poolId, lpTokenId: lpTokenId});
        emit PadLaunched(index, token, cfg.creator, hook, poolId, lpTokenId);
    }

    function _mintSeedLp(PoolKey memory key, LaunchConfig calldata cfg, Currency currency0, Currency currency1)
        internal
        returns (uint256 tokenId)
    {
        int24 tickLower = TickMath.minUsableTick(cfg.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(cfg.tickSpacing);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            cfg.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            msg.value, // amount0 = native ETH seed
            cfg.lpTokenAmount // amount1 = token seed
        );

        // approve Permit2 → PositionManager to pull the token seed during SETTLE_PAIR
        IERC20(Currency.unwrap(currency1)).approve(address(permit2), cfg.lpTokenAmount);
        permit2.approve(Currency.unwrap(currency1), address(positionManager), uint160(cfg.lpTokenAmount), MAX_UINT48);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            uint128(msg.value), // amount0Max
            uint128(cfg.lpTokenAmount), // amount1Max
            address(lockVault), // NFT recipient = the lock
            bytes("")
        );
        params[1] = abi.encode(currency0, currency1); // settle both (factory pays)
        params[2] = abi.encode(currency0, address(this)); // sweep native dust back to factory

        uint256 before = positionManager.nextTokenId();
        positionManager.modifyLiquidities{value: msg.value}(abi.encode(actions, params), block.timestamp);
        tokenId = before; // the id just minted (nextTokenId was `before`, now `before+1`)

        // [audit L4] Revoke the seed approvals — the mint pulls only `used <= lpTokenAmount`, leaving a
        // dangling max-expiry Permit2 grant otherwise. Zero both so no standing authority remains.
        permit2.approve(Currency.unwrap(currency1), address(positionManager), 0, 0);
        IERC20(Currency.unwrap(currency1)).approve(address(permit2), 0);
    }

    receive() external payable {}
}
