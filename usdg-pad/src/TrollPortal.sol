// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {TrollLaunchToken} from "./TrollLaunchToken.sol";
import {TrollRevenueSplitter} from "./TrollRevenueSplitter.sol";
import {TrollHook} from "./TrollHook.sol";
import {TrollLocker} from "./TrollLocker.sol";

/// @notice Permissionless factory: one transaction takes a creator from
/// nothing to a live, real Uniswap v4 pool trading their token's full
/// supply — no bonding curve, no graduation event, matching Argus's own
/// "real liquidity from block one" model (see PROJECT_NOTES.md, "DECIDED:
/// switch to Argus-style"). The full 1B supply is deposited as a single
/// concentrated position, resting entirely above (or below, depending on
/// token/quote address ordering) the chosen opening price — zero real
/// capital ever required to seed it, since a pool's starting price is set
/// for free via `IPoolManager.initialize`, completely independent of how
/// much liquidity is then deposited.
contract TrollPortal {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    address public immutable poolManager;
    address public immutable hook; // the one shared TrollHook instance (see TrollHook.sol)
    address public immutable treasury; // shared across every launch — see TrollTreasury.sol
    // Fixed per portal, not caller-controlled (audit finding M-1: a
    // per-launch quoteAsset let anyone route arbitrary — including
    // fee-on-transfer or non-standard — ERC-20s into the shared treasury,
    // breaking the "plain USDC" premise the rest of this system assumes,
    // and address(0) made every sell revert since native currency doesn't
    // support this hook's take()/safeTransfer-based tax path). On Arc this
    // is the USDC predeploy.
    address public immutable quoteAsset;

    // True only for Troll Pad's own original Portal, deployed directly (not
    // through TrollPadFactory). Passed down to each launch's
    // TrollRevenueSplitter, which uses it to decide the platform/creator
    // split ratio (10/90 on the main pad, 15/85 on every white-label pad).
    bool public immutable isMainPad;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint16 public constant MAX_TAX_BPS = 1_000; // 10% per side, same cap Argus uses
    uint24 public constant POOL_FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;

    // Bounds on a launch's opening market cap, in quoteAsset's raw units
    // (audit finding M-2: below ~$54 in 6-decimal USDC, the token1-ordering
    // price math — `FullMath.mulDiv(TOTAL_SUPPLY, 1 << 192, startingMarketCapQuote)`
    // — overflows uint256 with an opaque revert, but the SAME market cap
    // succeeds if the token happens to sort as currency0 instead; a
    // creator's launch silently failing or succeeding depending on an
    // address they don't control is its own bug independent of the
    // overflow. MIN sits safely above that threshold with headroom; MAX is
    // just a sanity ceiling).
    uint256 public constant MIN_STARTING_MC_QUOTE = 100e6; // $100
    uint256 public constant MAX_STARTING_MC_QUOTE = 1_000_000_000_000e6; // $1T

    address[] public allLaunches;
    mapping(address => address) public lockerForToken;

    error TaxTooHigh();
    error StartingMcOutOfRange();
    error ZeroAddress();

    event LaunchCreated(
        address indexed token,
        address indexed creator,
        address locker,
        address splitter,
        bytes32 poolId,
        address quoteAsset,
        bool tokenIsToken0,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        int24 tickLower,
        int24 tickUpper,
        uint160 initSqrtPriceX96,
        string name,
        string symbol
    );

    constructor(address poolManager_, address hook_, address treasury_, address quoteAsset_, bool isMainPad_) {
        if (quoteAsset_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        quoteAsset = quoteAsset_;
        isMainPad = isMainPad_;
    }

    struct CreateLaunchParams {
        string name;
        string symbol;
        // The launch's opening market cap, in this portal's quoteAsset's
        // raw units (e.g. 500e6 for a $500 opening MC against 6-decimal
        // USDC). Since the full supply is deposited at launch, MC = price *
        // TOTAL_SUPPLY, so this one number fully determines the pool's
        // starting price. No real quoteAsset is ever collected for this —
        // it only sets where IPoolManager.initialize() opens the price; see
        // _seedLaunchPool. Bounded by MIN/MAX_STARTING_MC_QUOTE.
        uint256 startingMarketCapQuote;
        // Creator's own choice, immutable once launched — applies from the
        // very first trade. Capped at 10% per side (MAX_TAX_BPS), same
        // ceiling Argus uses; either can be 0.
        uint16 buyTaxBps;
        uint16 sellTaxBps;
    }

    /// @dev Bundles _seedLaunchPool's return values — avoids stack-too-deep
    /// now that LaunchCreated carries the tick/price detail audit finding
    /// M-3 asked for (an indexer previously had no on-chain way to learn
    /// where the position actually sits, or that the pool's real opening
    /// price is up to one tick-spacing away from the requested one).
    struct SeedResult {
        PoolKey key;
        address locker;
        bool tokenIsToken0;
        int24 tickLower;
        int24 tickUpper;
        uint160 initSqrtPriceX96;
    }

    function createLaunch(CreateLaunchParams calldata p) external returns (address token, address locker) {
        if (p.buyTaxBps > MAX_TAX_BPS || p.sellTaxBps > MAX_TAX_BPS) revert TaxTooHigh();
        if (p.startingMarketCapQuote < MIN_STARTING_MC_QUOTE || p.startingMarketCapQuote > MAX_STARTING_MC_QUOTE) {
            revert StartingMcOutOfRange();
        }

        TrollLaunchToken tokenContract = new TrollLaunchToken(p.name, p.symbol, TOTAL_SUPPLY, address(this));
        token = address(tokenContract);

        TrollRevenueSplitter splitter = new TrollRevenueSplitter(msg.sender, treasury, address(this), isMainPad);

        SeedResult memory r =
            _seedLaunchPool(token, address(splitter), p.startingMarketCapQuote, p.buyTaxBps, p.sellTaxBps);
        locker = r.locker;

        lockerForToken[token] = locker;
        allLaunches.push(token);

        emit LaunchCreated(
            token,
            msg.sender,
            locker,
            address(splitter),
            PoolId.unwrap(r.key.toId()),
            quoteAsset,
            r.tokenIsToken0,
            p.buyTaxBps,
            p.sellTaxBps,
            r.tickLower,
            r.tickUpper,
            r.initSqrtPriceX96,
            p.name,
            p.symbol
        );
    }

    /// @dev Initializes the real v4 pool at the chosen opening price (free
    /// — see contract-level note), deploys this launch's Locker, transfers
    /// the full token supply to it, and seeds a single-sided concentrated
    /// position resting entirely on the token side — no quoteAsset is ever
    /// required. Registers the pool with the shared hook and authorizes
    /// both the hook and the Locker to deposit revenue into the splitter,
    /// then locks that source set forever.
    ///
    /// Note on the opening price: liquidity starts at `flooredTick +
    /// TICK_SPACING` (token0 case) or ends at `flooredTick` (token1 case),
    /// and the pool opens exactly at that edge. The opening market cap is
    /// therefore up to ~2% (one tick spacing) away from the requested
    /// `startingMarketCapQuote`; `LaunchCreated.initSqrtPriceX96` carries
    /// the exact opening price.
    function _seedLaunchPool(
        address token,
        address splitter,
        uint256 startingMarketCapQuote,
        uint16 buyTaxBps,
        uint16 sellTaxBps
    ) internal returns (SeedResult memory r) {
        bool tokenIsToken0 = token < quoteAsset;
        Currency currency0 = Currency.wrap(tokenIsToken0 ? token : quoteAsset);
        Currency currency1 = Currency.wrap(tokenIsToken0 ? quoteAsset : token);

        // Same amount0/amount1 -> sqrtPriceX96 pattern used elsewhere in
        // this repo's history: ratioX192 = amount1 * 2^192 / amount0,
        // sqrtPriceX96 = sqrt(ratioX192). FullMath is required since
        // amount1 * 2^192 overflows a plain uint256 multiply whenever
        // amount1 is the 18-decimal token leg (easily 1e27+).
        uint256 amount0 = tokenIsToken0 ? TOTAL_SUPPLY : startingMarketCapQuote;
        uint256 amount1 = tokenIsToken0 ? startingMarketCapQuote : TOTAL_SUPPLY;
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        uint160 startingSqrtPriceX96 = uint160(Math.sqrt(ratioX192));

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        int24 currentTick = TickMath.getTickAtSqrtPrice(startingSqrtPriceX96);
        int24 flooredTick = _floorToSpacing(currentTick, TICK_SPACING);
        // Divide-then-multiply is intentional here, not a precision bug:
        // MIN_TICK/MAX_TICK aren't already spacing-aligned, and this
        // truncates each toward zero, landing on a slightly less extreme
        // (safely still-valid) usable tick rather than needing the same
        // negative-aware floor `_floorToSpacing` provides below.
        int24 usableTickLow = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 usableTickHigh = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        if (tokenIsToken0) {
            // Ask wall for the token: a pure-token0 range strictly above
            // the opening price. flooredTick <= currentTick always, so
            // flooredTick + TICK_SPACING > currentTick always — that
            // strict inequality is what guarantees 100% token0 right now.
            tickLower = flooredTick + TICK_SPACING;
            tickUpper = usableTickHigh;
            // Derive liquidity from the ACTUAL tick boundaries, not the
            // raw unrounded startingSqrtPriceX96 — modifyLiquidity always
            // converts tickLower/tickUpper to sqrtPrice internally via
            // TickMath, and tickLower's rounded price differs slightly
            // from the raw starting price. Using the raw price here would
            // under-consume the deposited supply, leaving real dust stuck
            // in the Locker.
            liquidity = LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), TOTAL_SUPPLY
            );
        } else {
            // Mirrored: a pure-token1 range at/below the opening price.
            // tickUpper = flooredTick <= currentTick always, which
            // guarantees 100% token1 right now. Same tick-derived-price
            // reasoning as above applies to tickUpper here.
            tickLower = usableTickLow;
            tickUpper = flooredTick;
            liquidity = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), TOTAL_SUPPLY
            );
        }

        // Open the pool exactly at the position's near edge (2026-09-24
        // audit, portal-1/portal-2). Opening at the raw requested price left
        // an empty gap of up to one tick spacing between the price and the
        // liquidity: the first buy crossed it for free and paid up to ~2%
        // more than the advertised price, and anyone could push the price
        // around inside it at no cost. At the edge, the position is still
        // 100% launch token (sqrtPrice == sqrtA leaves amount1 at 0 for
        // token0; token1's range ends exactly at the price), and the first
        // buy fills at the first tick.
        startingSqrtPriceX96 = TickMath.getSqrtPriceAtTick(tokenIsToken0 ? tickLower : tickUpper);
        IPoolManager(poolManager).initialize(key, startingSqrtPriceX96);

        TrollLocker lockerContract =
            new TrollLocker(poolManager, splitter, address(this), key, tickLower, tickUpper, tokenIsToken0);
        r.locker = address(lockerContract);

        // Register before seeding: the hook only lets a pool's registered
        // locker add liquidity (audit hook-1).
        TrollHook(hook).registerPool(key, splitter, r.locker, quoteAsset, tokenIsToken0, buyTaxBps, sellTaxBps);

        IERC20(token).safeTransfer(r.locker, TOTAL_SUPPLY);
        lockerContract.seedLiquidity(liquidity);

        TrollRevenueSplitter(splitter).authorizeSource(hook);
        TrollRevenueSplitter(splitter).authorizeSource(r.locker);
        TrollRevenueSplitter(splitter).lockSources();

        r.key = key;
        r.tokenIsToken0 = tokenIsToken0;
        r.tickLower = tickLower;
        r.tickUpper = tickUpper;
        r.initSqrtPriceX96 = startingSqrtPriceX96;
    }

    /// @dev Floors `tick` to the nearest multiple of `spacing` at or below
    /// it. Plain integer division truncates toward zero, which is wrong
    /// for negative ticks (e.g. -7/200 truncates to 0, not -1 — the actual
    /// floor), so this corrects for that case explicitly.
    function _floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 quotient = tick / spacing;
        if (tick % spacing != 0 && tick < 0) {
            quotient -= 1;
        }
        return quotient * spacing;
    }

    function launchCount() external view returns (uint256) {
        return allLaunches.length;
    }
}
