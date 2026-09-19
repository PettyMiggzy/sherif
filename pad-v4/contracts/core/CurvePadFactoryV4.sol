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
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";

import {DeterministicDeployer} from "./DeterministicDeployer.sol";
import {FeeHookDeployer} from "./FeeHookDeployer.sol";
import {CurveV4Deployer} from "./CurveV4Deployer.sol";
import {LockVault} from "./LockVault.sol";
import {RobinV4FeeConfig} from "./RobinV4FeeConfig.sol";
import {PadToken} from "../pads/PadToken.sol";
import {RobinFeeHook} from "../hooks/RobinFeeHook.sol";
import {RobinCurveV4} from "../pads/RobinCurveV4.sol";
import {IRobinFeeHookAdmin} from "../interfaces/IRobinInterfaces.sol";
import {PadBrand} from "./PadBrand.sol";
import {PadValuation} from "./PadValuation.sol";

/// @dev [AUCTION] Thin slice of DailyAuctionVaultV4Deployer (AuctionV4Deployers.sol) this factory needs to
/// spin up an optional auction vault at launch time.
interface IDailyAuctionVaultV4Deployer {
    function deploy(
        address token,
        address poolManager,
        address curve,
        address feeRegistry,
        uint8 auctionDays,
        uint256 auctionAmt
    ) external returns (address);
}

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
    /// [EIP-170] Holds `RobinFeeHook`'s creationCode so this factory does not (see FeeHookDeployer). Forwards to
    /// the SAME `deployer`, so every mined hook address is derived exactly as before.
    FeeHookDeployer public immutable feeHookDeployer;
    CurveV4Deployer public immutable curveDeployer; // offloads RobinCurveV4 creationCode (24KB limit)
    RobinV4FeeConfig public immutable feeConfig;
    address public immutable feeRegistry;
    LockVault public immutable lockVault;
    /// @notice [AUCTION] address(0) disables the auction feature on this deployment entirely — a launch with
    /// cfg.auctionDays > 0 reverts BadConfig rather than deploying a vault. Constructor-immutable, not
    /// owner-settable: unlike v3's CurvePadFactory (already Ownable2Step for unrelated reasons), this factory
    /// has no owner concept anywhere else, and every other economic/infra wiring here is already a constructor
    /// immutable — adding a one-off owner just for this would be a bigger, more invasive change than the ripple
    /// of one more constructor argument.
    address public immutable auctionVaultDeployer;

    uint160 internal constant HOOK_FLAGS = 0x28CC;
    // [L-1] SAFETY FLOOR (not a product minimum): the minimum ETH the curve integral must yield for cfg.curveSupply
    // over [gradTick, startTick]. A too-high startTickMag lets the raise truncate toward 0 wei, so graduate() would
    // revert EmptyRaise permanently. Set to 1e12 (0.000001 ETH) so it catches only a genuinely degenerate/dust curve
    // — the testnet-e2e geometry (curveSupply 100k → ~5.5e14 wei raise) and all production geometries pass with wide
    // margin. If the operator wants a higher PRODUCT minimum raise, that is a policy knob to raise deliberately.
    uint256 internal constant MIN_RAISE_WEI = 1e12;
    // [LP-FEE] Uniswap's own protocol-level flag (LPFeeLibrary.DYNAMIC_FEE_FLAG) marking a pool as dynamic-fee
    // rather than static. Duplicated from RobinV4FeeConfig (internal there) rather than imported — it's a fixed
    // constant, not a policy value, so there's nothing to drift.
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;

    struct LaunchConfig {
        string name;
        string symbol;
        uint8 decimals;
        uint256 supply; // total minted to the factory
        uint256 curveSupply; // tokens SOLD via the single-sided curve
        uint256 reserveSupply; // tokens HELD BACK (never in the curve) to pair the permanent LP + feed staking
        int24 tickSpacing;
        // [FDV] Creator-chosen launch-price magnitude in ticks; 0 = use the governed default. This is the ONLY
        // geometry knob a caller gets: `curveWidth` (launch -> graduation ceiling) stays global, so picking a
        // start price moves the valuation without changing the multiple every coin graduates at.
        int24 startTickMag;
        address creator; // gets supply - curveSupply - reserveSupply
        // [NO-POOL] Creator's structural pad-type choice — true asks for a "checkpoint, not exit" graduation
        // (RobinCurveV4.noPoolForever). Gated on RobinV4FeeConfig.noPoolForeverEnabled(); the bps of curve
        // liquidity withdrawn at that checkpoint is GOVERNED (feeConfig.visibilityWithdrawBpsDefault()), never
        // creator-chosen — same "economics come from feeConfig, never the caller" rule every other bps here
        // follows.
        bool noPoolForever;
        // [LP-FEE] The ONE deliberate exception to "economics come from feeConfig, never the caller" — see
        // ICurvePadFactoryV4.LaunchConfig's doc comment for why letting a creator pick their own static pool
        // fee (0 up to the governed MAX_LP_FEE ceiling) doesn't weaken that rule. Appended last so this mirrors
        // ICurvePadFactoryV4.LaunchConfig field-for-field.
        uint24 lpFee;
        // [AUCTION] 0-4 day optional pre-launch daily batch auction — see ICurvePadFactoryV4.LaunchConfig's
        // doc comment. Appended last so this mirrors that struct field-for-field.
        uint8 auctionDays;
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
    mapping(address token => address) public auctionVaultOf; // [AUCTION] set only when cfg.auctionDays > 0

    event CurvePadLaunched(
        uint256 indexed index, address indexed token, address indexed creator, address hook, address curve, PoolId poolId
    );
    // [AUCTION] Separate from CurvePadLaunched rather than extending it, so every existing consumer of that
    // event's ABI is unaffected by this feature.
    event AuctionVaultLaunched(uint256 indexed index, address indexed token, address auctionVault, uint256 auctionAmt);

    error HookFlagsMismatch();
    error LockVaultMismatch();
    error NotRegistrar();
    error BadConfig();
    error AlreadyLaunched();
    error BadGeometry();
    error MarketCapOutOfRange(uint256 fdvWei); // [FDV] supply x launch price outside the governed band
    error NotCurve();
    error PoolAlreadyInit();
    error NoPoolForeverDisabled(); // [NO-POOL] cfg.noPoolForever requested but feeConfig hasn't opted the pad type in

    constructor(
        address poolManager_,
        address positionManager_,
        address permit2_,
        address stateView_,
        address deployer_,
        address curveDeployer_,
        address feeConfig_,
        address feeRegistry_,
        address lockVault_,
        address auctionVaultDeployer_,
        address feeHookDeployer_ // [EIP-170] holds RobinFeeHook's creationCode
    ) {
        if (feeHookDeployer_ == address(0)) revert BadConfig();
        feeHookDeployer = FeeHookDeployer(feeHookDeployer_);
        poolManager = IPoolManager(poolManager_);
        positionManager = positionManager_;
        permit2 = permit2_;
        stateView = stateView_;
        deployer = DeterministicDeployer(deployer_);
        curveDeployer = CurveV4Deployer(curveDeployer_);
        feeConfig = RobinV4FeeConfig(feeConfig_);
        feeRegistry = feeRegistry_;
        lockVault = LockVault(payable(lockVault_));
        // [AUCTION] address(0) is a valid, deliberate "feature off on this deployment" value — see the
        // storage var's own doc comment. Not validated against zero on purpose.
        auctionVaultDeployer = auctionVaultDeployer_;
        // [I-1(19)] The vault holds its OWN positionManager immutable and uses it for collectFees and for the
        // onERC721Received gate. Nothing else cross-checks the two, and the gate is dead code on the mint path
        // (v4-periphery mints with solmate's plain _mint), so a divergence would let graduate() succeed, lock
        // the LP, and only then leave every pad's fee stream permanently uncollectable. The getter is public
        // and free — assert it here, where a mismatch costs a failed deploy instead of a dead pad.
        if (address(lockVault.positionManager()) != positionManager_) revert LockVaultMismatch();
    }

    // ── launch-client helpers (pure/view; nothing on the hot path calls these) ─────────────────────────────
    //
    // A creator picks SUPPLY and VALUATION, not a tick. These two reads are what a UI needs to turn that choice
    // into a `LaunchConfig` without reimplementing Q96 tick math or reaching into the FeeConfig's layout — and,
    // more importantly, without HARDCODING a band: `minFdvWei`/`maxFdvWei` are wei on a chain with no USD oracle,
    // so the operator retunes them as ETH moves and a client that baked in yesterday's numbers starts quoting
    // launches that revert.

    /// @notice The implied fully-diluted value, in wei, that `supply` tokens launched at `startTick` would carry.
    /// @dev EXACTLY the value `launch` checks against the band — same library, no second implementation.
    function quoteFdvWei(uint256 supply, int24 startTick) external pure returns (uint256) {
        return PadValuation.fdvWei(supply, startTick);
    }

    /// @notice The currently-governed valuation band [min, max] in wei. Read it; never assume it.
    function fdvBand() external view returns (uint256 minWei, uint256 maxWei) {
        RobinV4FeeConfig.Defaults memory d = feeConfig.defaults();
        return (d.minFdvWei, d.maxFdvWei);
    }

    /// @notice Launch a free single-sided curve pad. `tokenSalt` is any CREATE2 salt (token only needs to sort
    /// above native(0), always true). `hookSalt` is mined off-chain so the hook carries flags 0x28CC.
    function launch(LaunchConfig calldata cfg, bytes32 tokenSalt, bytes32 hookSalt, bytes32 curveSalt)
        external
        returns (address token, address hook, address curve, PoolId poolId)
    {
        // [M-2] LockVault has ONE registrar slot and three factories can be pointed at it. If this factory is not
        // the registered one, every launch here still succeeds and only graduate() step 5 fails — permanently,
        // for every caller, with the raise already collected. Fail here instead, before a single wei is at risk.
        if (lockVault.factory() != address(this)) revert NotRegistrar();

        // NO DEV MINT: the whole supply must be exactly the sellable curve + the held reserve — nothing is left
        // over to hand the creator. The creator (dev) gets tokens ONLY by BUYING from the curve like everyone else,
        // so there is no premine to red-flag on a scanner and no pre-bought bag that front-runs the public.
        if (
            cfg.creator == address(0) || cfg.supply == 0 || cfg.curveSupply == 0 || cfg.reserveSupply == 0
                || cfg.curveSupply + cfg.reserveSupply != cfg.supply
        ) revert BadConfig();
        // [LP-FEE] The creator's own choice, always read literally (no "0 = use governed default" sentinel —
        // 0 is a real, legitimate choice: a coin with no LP fee at all). Same static-only + ceiling checks
        // RobinV4FeeConfig._validate applies to the governed default, applied here to the caller's choice.
        if (cfg.lpFee & DYNAMIC_FEE_FLAG != 0 || cfg.lpFee > feeConfig.MAX_LP_FEE()) revert BadConfig();
        // [AUCTION] Same bound as v3's DailyAuctionVault (0-4 days), and the feature must actually be wired on
        // this deployment — an unset auctionVaultDeployer means "off", not "silently ignored".
        if (cfg.auctionDays > 4) revert BadConfig();
        if (cfg.auctionDays > 0 && auctionVaultDeployer == address(0)) revert BadConfig();

        // [AUCTION] Carve `auctionDays * 10%` of the CURVE'S sellable share out before the curve is seeded —
        // dayTranche computed FIRST (10% of the pre-carve curveSupply) so auctionAmt = dayTranche * auctionDays
        // divides evenly by construction, never by a separate rounding division. `curveSupply` (this reduced
        // local) is what actually gets seeded and what the geometry checks below size against; cfg.curveSupply
        // itself is left untouched (it is still what cfg.reserveSupply's own check is measured against, and
        // still what the supply-conservation check above already validated). At the max (4 days) the curve
        // still seeds with 60% of the original curveSupply.
        uint256 curveSupply = cfg.curveSupply;
        uint256 dayTranche = cfg.auctionDays == 0 ? 0 : curveSupply / 10;
        uint256 auctionAmt = dayTranche * cfg.auctionDays;
        curveSupply -= auctionAmt;
        if (curveSupply == 0) revert BadConfig();

        // 1) governed defaults, snapshotted + stamped immutably
        RobinV4FeeConfig.Defaults memory d = feeConfig.defaults(); // all shares/geometry validated in the FeeConfig
        // [NO-POOL] Structural pad-type choice is the creator's; its economics are NOT. A creator can ask for
        // noPoolForever, but only ever gets the GOVERNED visibilityWithdrawBps — never one of their own choosing
        // — and only if the platform has opted the pad type in at all. Snapshotted here, same as every other
        // bps below, so a mid-tx retune can't change what THIS launch stamps immutably onto the curve.
        uint16 visibilityWithdrawBps = 0;
        if (cfg.noPoolForever) {
            if (!feeConfig.noPoolForeverEnabled()) revert NoPoolForeverDisabled();
            visibilityWithdrawBps = feeConfig.visibilityWithdrawBpsDefault();
        }
        int24 ts = cfg.tickSpacing;
        // [FDV] The creator may pick their own launch price; 0 keeps the governed default. `curveWidth` stays
        // GLOBAL on purpose — it is the tick span from launch to the graduation ceiling, so holding it fixed
        // means every coin still graduates at the SAME multiple of its own launch price no matter what
        // valuation or supply was chosen. Only the absolute starting point moves.
        int24 startMag = PadValuation.startTickOf(cfg.startTickMag, int24(d.startTickMag));
        if (ts <= 0 || startMag <= 0 || startMag % ts != 0 || d.curveWidth % ts != 0) revert BadGeometry();
        int24 startTick = startMag; // token = currency1 ⇒ launch at the high (top) tick
        int24 gradTick = startTick - int24(d.curveWidth); // ceiling (lower); startTick/gradTick are ts-aligned
        // gradTick must be strictly ABOVE minUsableTick: at == it, √grad == √minTick and _mintPermanentLp's
        // getLiquidityForAmount1(√min, √grad, …) divides by zero (reverting graduation). [D-2]
        // gradTick must also sit a safe margin BELOW maxUsableTick: the permanent LP's full-range token leg costs
        // curveSupply·(√grad/√start)·√max/(√max−√grad), and that √max/(√max−√grad) factor only stays within the
        // reserve check's 5% margin below while √grad/√max is small. An 80,000-tick gap keeps √grad/√max ≲ 1.8%
        // (factor ≲ 1.019), leaving comfortable headroom so the ETH leg always binds and the raise can never be
        // trapped by InsufficientReserve. [AUDIT] Only reachable via an absurd near-max launch price anyway. [D-3]
        int24 maxTick = TickMath.maxUsableTick(ts);
        if (startTick > maxTick || gradTick <= TickMath.minUsableTick(ts) || gradTick > maxTick - 80000) {
            revert BadGeometry();
        }
        // [FDV] BOUND THE VALUATION, NOT THE SUPPLY. Supply is deliberately unconstrained — 10,000 tokens and
        // 10,000,000,000 tokens are both legitimate — because supply alone means nothing; what matters is
        // supply x price. currency0 is ETH and currency1 is the token, so the pool price is TOKENS-PER-ETH and
        // the implied fully-diluted value in wei is supply / price = supply * 2^192 / sqrtP^2. That is computed
        // in two mulDiv steps because sqrtP^2 alone overflows uint256 at high ticks.
        {
            uint256 fdvWei = PadValuation.fdvWei(cfg.supply, startTick);
            if (fdvWei < d.minFdvWei || fdvWei > d.maxFdvWei) revert MarketCapOutOfRange(fdvWei);
        }

        // [HIGH-2] the reserve must be big enough that the ETH leg binds at graduation — otherwise the raise
        // would leak to the platform book, or (too small) brick graduation and trap the raise forever. Require
        // reserveSupply ≥ curveSupply·√grad/√start with a 5% margin (√grad < √start ⇒ threshold < curveSupply).
        // [AUCTION] Measured against the REDUCED `curveSupply` (post carve-out) — that is what actually gets
        // seeded into the curve and is what the permanent LP must be sized to pair at graduation. The carved-out
        // auction supply never enters the curve, so it must not inflate this requirement.
        {
            uint256 sg = uint256(TickMath.getSqrtPriceAtTick(gradTick));
            uint256 ss = uint256(TickMath.getSqrtPriceAtTick(startTick));
            if (uint256(cfg.reserveSupply) * ss * 100 < curveSupply * sg * 105) revert BadConfig();
        }
        // [L-1] RAISE FLOOR: the geometry checks above bound the LP token-leg pairing, not the ETH raise. Compute the
        // ETH the single-sided position [gradTick, startTick] actually yields for curveSupply and reject a
        // geometry whose raise would floor to ~0 wei (else graduate() reverts EmptyRaise forever). currency1 = token,
        // so the sold supply is the amount1 leg; getAmount0ForLiquidity then gives the ETH walked out over the range.
        {
            uint160 sqGrad = TickMath.getSqrtPriceAtTick(gradTick);
            uint160 sqStart = TickMath.getSqrtPriceAtTick(startTick);
            uint128 curveL = LiquidityAmounts.getLiquidityForAmount1(sqGrad, sqStart, curveSupply);
            // ETH walked out over [gradTick, startTick] for that liquidity (round DOWN — a lower bound on the raise),
            // mirroring PresaleVault._absorbableIn's getAmount0Delta(gradSqrt, startSqrt, L, false).
            if (SqrtPriceMath.getAmount0Delta(sqGrad, sqStart, curveL, false) < MIN_RAISE_WEI) revert BadGeometry();
        }

        // 2) deploy the token (supply minted to this factory)
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
        // (scripts/mine.js mineTokenSalt). Checked before ANY pool/curve state is written, so an unmined salt
        // fails loudly and cannot half-create a pad. Covers the Arrow path too, since ArrowLauncher launches
        // through this factory. See contracts/core/PadBrand.sol.
        PadBrand.requireBrand(token);

        // [M-27] launch() is permissionless and NOTHING upstream is keyed on the whole PoolKey: the deterministic
        // deployer ADOPTS a byte-identical pre-deploy rather than reverting, the token init-code carries only
        // (name, symbol, decimals, supply, factory), the hook init-code only (poolManager, factory, registry,
        // token), and registerPool rejects only a repeat of the SAME PoolId. So the same salts with a different
        // fee or tickSpacing produced a SECOND live pool over an already-launched pad token.
        if (PoolId.unwrap(poolOf[token]) != bytes32(0)) revert AlreadyLaunched();

        Currency currency0 = Currency.wrap(address(0)); // ETH
        Currency currency1 = Currency.wrap(token);

        // 3) deploy the flag-mined hook (token in init-code ⇒ unique address per pad)
        // [EIP-170] the hook's creationCode is held by FeeHookDeployer, not inlined here — the [H-5] floor gate
        // pushed the inline copy past the 24,576-byte limit on StockPadFactory. CREATE2 derivation is unchanged:
        // FeeHookDeployer forwards to this same `deployer`, so the mined address formula is byte-identical.
        hook = feeHookDeployer.deploy(
            hookSalt, abi.encode(poolManager, address(this), feeRegistry, token)
        );
        if (uint160(hook) & 0x3FFF != HOOK_FLAGS) revert HookFlagsMismatch();
        if (RobinFeeHook(payable(hook)).REQUIRED_FLAGS() != HOOK_FLAGS) revert HookFlagsMismatch();

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: cfg.lpFee,
            tickSpacing: ts,
            hooks: IHooks(hook)
        });
        poolId = key.toId();
        // [M-27] Claim the token HERE, at the earliest point poolId exists — not at the end of launch(). The
        // guard above only closes the door if the write happens before any external call this function makes,
        // otherwise a re-entrant creator callback could slip a second launch past it inside the same tx.
        poolOf[token] = poolId;

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
                buyBufferShareBps: d.buyBufferShareBps,
                referralShareBps: d.referralShareBps,
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
                cfg.lpFee,
                ts,
                hook,
                startTick,
                gradTick,
                d.buyLpFloorShareBps,
                d.platformGradBps,
                d.creatorGradBps,
                d.ambushGradBps,
                cfg.creator,
                cfg.noPoolForever,
                visibilityWithdrawBps
            )
        );
        isCurve[curve] = true;
        // wire the curve as the buy-tax buffer sink ([L-5] the buffer is held as idle ETH, then swept to the PLATFORM at graduation); known only now
        RobinFeeHook(payable(hook)).setBufferRecipient(poolId, curve);

        // [AUCTION] Deploy the optional vault now — after the curve exists (it reads currency0/currency1/fee/
        // tickSpacing/hooks/gradTick straight off it), before any token moves. auctionVaultOf is set here so it
        // reads correctly even if a later external call in this function were somehow to re-enter (it can't:
        // PadToken/RobinFeeHook/RobinCurveV4 are all audited, non-callback code paths here).
        address auctionVault;
        if (cfg.auctionDays > 0) {
            auctionVault = IDailyAuctionVaultV4Deployer(auctionVaultDeployer).deploy(
                token, address(poolManager), curve, feeRegistry, cfg.auctionDays, auctionAmt
            );
            auctionVaultOf[token] = auctionVault;
        }

        IERC20(token).safeTransfer(curve, curveSupply); // the SOLD (post carve-out) portion → seeded into the curve
        RobinCurveV4(payable(curve)).seed();
        IERC20(token).safeTransfer(curve, cfg.reserveSupply); // the HELD reserve → pairs the permanent LP + staking
        if (auctionVault != address(0)) IERC20(token).safeTransfer(auctionVault, auctionAmt);

        // 6) NO remainder: supply == curveSupply + reserveSupply is enforced above, and curveSupply(reduced) +
        //    auctionAmt == cfg.curveSupply by construction, so the factory holds 0 token now — nothing is minted
        //    to the creator (no premine). Any stray dust is left untouched (never sent).

        uint256 index = launchCount++;
        launches[index] = Launch({token: token, hook: hook, curve: curve, poolId: poolId});
        emit CurvePadLaunched(index, token, cfg.creator, hook, curve, poolId);
        if (auctionVault != address(0)) emit AuctionVaultLaunched(index, token, auctionVault, auctionAmt);
    }

    /// @notice Called by a graduating curve controller to register its permanent locked LP. LockVault accepts
    /// registerLaunch only from this factory, so routing through here keeps the vault's sole-registrar invariant.
    function onGraduated(uint256 lpTokenId, Currency c0, Currency c1, address staking) external {
        if (!isCurve[msg.sender]) revert NotCurve();
        lockVault.registerLaunch(lpTokenId, c0, c1, staking);
    }
}
