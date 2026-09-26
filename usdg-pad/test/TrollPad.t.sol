// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "@uniswap/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {TrollPortal} from "../src/TrollPortal.sol";
import {TrollHook} from "../src/TrollHook.sol";
import {TrollRevenueSplitter} from "../src/TrollRevenueSplitter.sol";
import {TrollLocker} from "../src/TrollLocker.sol";
import {TrollLaunchToken} from "../src/TrollLaunchToken.sol";
import {TrollPadFactory} from "../src/TrollPadFactory.sol";
import {PadPortal} from "../src/PadPortal.sol";
import {PadRevenueSplitter} from "../src/PadRevenueSplitter.sol";
import {TrollTreasury} from "../src/TrollTreasury.sol";
import {PadPortalTemplate} from "../src/PadPortalTemplate.sol";
import {IPadTemplate} from "../src/interfaces/IPadTemplate.sol";

contract TrollPadTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    MockERC20 usdc;
    TrollHook hook;
    TrollPortal portal;
    TrollPadFactory factory;
    PadRevenueSplitter splitterImpl;
    TrollTreasury treasury;
    address treasuryOwner = makeAddr("treasuryOwner");
    address creator = makeAddr("creator");
    address trader1 = makeAddr("trader1");
    address trader2 = makeAddr("trader2");
    address customer = makeAddr("customer"); // buys a white-label pad from the factory

    uint256 constant USDC_DECIMALS = 1e6;
    uint256 constant STARTING_MC = 500 * USDC_DECIMALS; // $500 opening market cap, zero real capital required
    uint256 constant SETUP_FEE = 100 * USDC_DECIMALS;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 ether;

    function setUp() public {
        deployFreshManagerAndRouters(); // sets up `manager` + `swapRouter` (PoolSwapTest)
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Flags required post-audit (Fable's fixes): BEFORE_INITIALIZE gates
        // pool creation to authorized portals (closes the pre-initialize
        // griefing vector, H-3); BEFORE_SWAP + BEFORE_SWAP_RETURNS_DELTA let
        // the hook tax the specified leg when quote is specified (needed so
        // tax always lands in quote, not the launch token — H-1);
        // AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA handle the complementary
        // case. Without the RETURNS_DELTA bits, a hook's returned delta is
        // silently ignored and every real swap reverts with
        // CurrencyNotSettled() — see TrollHook's contract-level comment.
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory creationCode = type(TrollHook).creationCode;
        // bootstrapper = address(this): this test contract is the one that
        // calls bootstrapMainPortal/bootstrapFactory below, so it must be
        // the address baked into the hook's constructor (audit finding
        // D-1) — not captured as msg.sender inside the constructor itself.
        bytes memory constructorArgs = abi.encode(address(manager), address(this));
        (address predictedHook, bytes32 salt) = HookMiner.find(address(this), flags, creationCode, constructorArgs);

        hook = new TrollHook{salt: salt}(address(manager), address(this));
        require(address(hook) == predictedHook, "hook address mismatch");

        treasury = new TrollTreasury(treasuryOwner);

        portal = new TrollPortal(address(manager), address(hook), address(treasury), address(usdc), true);
        hook.bootstrapMainPortal(address(portal));

        splitterImpl = new PadRevenueSplitter();
        factory = new TrollPadFactory(
            address(manager), address(hook), address(treasury), address(usdc), address(splitterImpl), SETUP_FEE, address(this)
        );
        hook.bootstrapFactory(address(factory));

        usdc.mint(creator, 100_000 * USDC_DECIMALS);
        usdc.mint(trader1, 100_000 * USDC_DECIMALS);
        usdc.mint(trader2, 100_000 * USDC_DECIMALS);
        usdc.mint(customer, 100_000 * USDC_DECIMALS);
    }

    // Hook mining uses Uniswap's own `HookMiner.find` (audit findings
    // D-4/D-6: no vm.ffi, no Python, nothing outside Solidity to trust).
    // Calling it twice with identical (deployer, flags, initCode) inputs —
    // as the blocklist test below does, re-mining against the exact same
    // setUp() inputs — naturally finds a DIFFERENT salt the second time:
    // HookMiner.find skips any candidate address that already has code,
    // and setUp()'s hook already occupies the first match.

    function _createLaunch(TrollPortal p, uint16 buyTaxBps, uint16 sellTaxBps)
        internal
        returns (address token, address locker)
    {
        vm.prank(creator);
        (token, locker) = p.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Test Troll",
                symbol: "TTROLL",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: buyTaxBps,
                sellTaxBps: sellTaxBps
            })
        );
    }

    function _keyFor(address token) internal view returns (PoolKey memory) {
        bool tokenIsToken0 = token < address(usdc);
        return PoolKey({
            currency0: tokenIsToken0 ? Currency.wrap(token) : Currency.wrap(address(usdc)),
            currency1: tokenIsToken0 ? Currency.wrap(address(usdc)) : Currency.wrap(token),
            fee: portal.POOL_FEE(),
            tickSpacing: portal.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
    }

    /// @dev Swaps `quoteIn` of USDC for `token`, working out the correct
    /// zeroForOne direction regardless of which address happens to sort
    /// lower (token/quote ordering is not something a test should assume).
    function _buy(address trader, address token, PoolKey memory key, uint256 quoteIn) internal returns (uint256 tokensOut) {
        bool tokenIsToken0 = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = !tokenIsToken0; // giving quote, receiving token
        uint256 tokenBefore = TrollLaunchToken(token).balanceOf(trader);

        vm.startPrank(trader);
        usdc.approve(address(swapRouter), quoteIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        tokensOut = TrollLaunchToken(token).balanceOf(trader) - tokenBefore;
    }

    /// @dev Sells `tokenIn` of `token` for USDC, same direction-agnostic
    /// approach as `_buy`.
    function _sell(address trader, address token, PoolKey memory key, uint256 tokenIn) internal returns (uint256 quoteOut) {
        bool tokenIsToken0 = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = tokenIsToken0; // giving token, receiving quote
        uint256 quoteBefore = usdc.balanceOf(trader);

        vm.startPrank(trader);
        TrollLaunchToken(token).approve(address(swapRouter), tokenIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(tokenIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        quoteOut = usdc.balanceOf(trader) - quoteBefore;
    }

    function _sqrtPrice(PoolKey memory key) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = manager.getSlot0(key.toId());
    }

    // ------------------------------------------------------------------
    // Launch creates a real pool, live from block one
    // ------------------------------------------------------------------

    function test_LaunchCreatesRealPoolWithFullLiquidity() public {
        (address token, address locker) = _createLaunch(portal, 100, 150);

        // Once seeded, the full supply moves OUT of the locker and INTO
        // the pool as the position's reserves — the locker holds the
        // abstract LP position, not a matching raw token balance. Only a
        // tiny rounding remainder (integer tick math, a fraction of a wei
        // relative to 1e27) should be left sitting in the locker as dust.
        assertLt(
            TrollLaunchToken(token).balanceOf(locker),
            1e12,
            "locker should have almost no raw token balance left - the supply now backs the pool position"
        );
        assertEq(TrollLaunchToken(token).totalSupply(), TOTAL_SUPPLY, "total supply should be exactly 1B");
        assertTrue(TrollLocker(locker).seeded(), "locker should be seeded immediately, no separate step");

        // Not manager.getLiquidity() — that reflects only liquidity ACTIVE
        // at the pool's current tick, and this ask-wall position is
        // deliberately placed entirely above (or below) the current price,
        // so it never contributes to "active" liquidity until a trade
        // pushes price into its range. Read the specific position instead.
        PoolKey memory key = _keyFor(token);
        (uint128 positionLiquidity,,) = manager.getPositionInfo(
            key.toId(), locker, TrollLocker(locker).tickLower(), TrollLocker(locker).tickUpper(), bytes32(0)
        );
        assertGt(positionLiquidity, 0, "the locker's position should hold real liquidity from the moment it's created");
    }

    function test_BuyIncreasesPriceAndDeliversTokens() public {
        (address token,) = _createLaunch(portal, 100, 150);
        PoolKey memory key = _keyFor(token);

        uint160 priceBefore = _sqrtPrice(key);
        uint256 tokensOut = _buy(trader1, token, key, 50 * USDC_DECIMALS);
        uint160 priceAfter = _sqrtPrice(key);

        assertGt(tokensOut, 0, "buyer should receive tokens");
        // Price direction depends on token/quote ordering, but magnitude
        // moving away from the opening price either way proves the trade
        // actually consumed the single-sided position.
        assertTrue(priceAfter != priceBefore, "price should move after a buy");
    }

    /// @notice Right after launch there is deliberately no bid-side
    /// liquidity (the position is 100% launch token, an ask wall) — no
    /// real money was ever deposited, so there's nothing to sell into yet.
    /// A sell only becomes possible once a buy has pushed some real quote
    /// into the position. This is the expected shape of the design, not a
    /// bug: zero real capital risk means zero depth until real buyers
    /// create it.
    function test_SellWorksOnlyAfterABuyCreatesBidSideDepth() public {
        (address token,) = _createLaunch(portal, 100, 150);
        PoolKey memory key = _keyFor(token);

        _buy(trader1, token, key, 200 * USDC_DECIMALS);
        uint256 tokenBal = TrollLaunchToken(token).balanceOf(trader1);
        assertGt(tokenBal, 0);

        uint256 sellAmount = tokenBal / 4; // small relative to the buy, safely within the new bid-side depth
        uint160 priceBeforeSell = _sqrtPrice(key);
        uint256 quoteOut = _sell(trader1, token, key, sellAmount);
        uint160 priceAfterSell = _sqrtPrice(key);

        assertGt(quoteOut, 0, "seller should receive quote once bid-side depth exists");
        assertTrue(priceAfterSell != priceBeforeSell, "price should move after a sell");
    }

    /// @notice Directly proves the creator's buy/sell rates are independent
    /// and actually applied — not just "a fee gets taken", but the RIGHT
    /// fee for each direction (buyTaxBps=100=1%, sellTaxBps=150=1.5% in
    /// this launch's params), split flat 90/10 with no subdivision, and
    /// ALWAYS denominated in quote (USDC) — never in the launch token,
    /// buy or sell alike. Fable's audit (H-1) found the pre-fix hook taxed
    /// whichever currency was "unspecified", which meant every ordinary
    /// exact-input buy — what every router sends by default — was taxed in
    /// the launch token instead: a 10% buy tax handed the creator a
    /// claimable, dumpable 9% of the tokens bought on every single buy.
    /// This test is the direct regression check for that fix.
    function test_BuyAndSellTaxAreBothAlwaysInQuoteNeverInLaunchToken() public {
        (address token, address locker) = _createLaunch(portal, 100, 150);
        PoolKey memory key = _keyFor(token);
        address splitter = TrollLocker(locker).splitter();

        uint256 quoteIn = 200 * USDC_DECIMALS;
        _buy(trader1, token, key, quoteIn);
        hook.flush(key); // moves the hook's accrued ERC-6909 claim into the splitter

        // The buy tax must land in USDC, and must NOT accrue any credit in
        // the launch token at all — the exact H-1 regression.
        assertEq(TrollRevenueSplitter(splitter).creditedToCreator(token), 0, "buy tax must never be credited in the launch token");
        uint256 creditedAfterBuy = TrollRevenueSplitter(splitter).creditedToCreator(address(usdc));
        assertGt(creditedAfterBuy, 0, "creator should be credited some of the buy tax, in USDC");

        uint256 tokenBal = TrollLaunchToken(token).balanceOf(trader1);
        _sell(trader1, token, key, tokenBal / 2);
        hook.flush(key);

        // The sell tax also lands in USDC — same ledger entry the buy tax
        // used, since both are quote-denominated now.
        uint256 creditedAfterSell = TrollRevenueSplitter(splitter).creditedToCreator(address(usdc));
        assertGt(creditedAfterSell, creditedAfterBuy, "creator should be credited some of the sell tax too, in the same USDC ledger");
        assertEq(TrollRevenueSplitter(splitter).creditedToCreator(token), 0, "sell tax must never be credited in the launch token either");

        // The tax never touched the hook's own ERC-20 balance or the
        // splitter's balance outside the credited ledger — it moved purely
        // through ERC-6909 claims until flush() settled it (H-2's fix).
        assertEq(TrollLaunchToken(token).balanceOf(address(hook)), 0, "hook should never hold raw launch tokens");
    }

    /// @notice A random, non-portal caller can never sneak a pool through
    /// this hook by calling PoolManager.initialize directly — closing the
    /// pre-launch griefing vector Fable's audit found (H-3): a launch's
    /// token address is predictable ahead of time, so without this gate
    /// anyone could initialize the exact pool key first and permanently
    /// block the real createLaunch with PoolAlreadyInitialized.
    function test_PreInitializeGriefingByNonPortalIsBlocked() public {
        address griefer = makeAddr("griefer");
        address predictedNextToken = makeAddr("predictedNextToken"); // stand-in for a predicted CREATE address
        bool tokenIsToken0 = predictedNextToken < address(usdc);
        PoolKey memory key = PoolKey({
            currency0: tokenIsToken0 ? Currency.wrap(predictedNextToken) : Currency.wrap(address(usdc)),
            currency1: tokenIsToken0 ? Currency.wrap(address(usdc)) : Currency.wrap(predictedNextToken),
            fee: portal.POOL_FEE(),
            tickSpacing: portal.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });

        // The hook's revert bubbles up wrapped in v4-core's own
        // CustomRevert.WrappedError (see Hooks.callHook) rather than as the
        // raw selector, so this only asserts that SOME revert happens, not
        // its exact encoding — the point is that the pool never gets
        // initialized, not the wrapper format.
        vm.prank(griefer);
        vm.expectRevert();
        manager.initialize(key, uint160(1) << 96);
    }

    function test_TaxAboveTenPercentCapIsRejected() public {
        vm.prank(creator);
        vm.expectRevert(TrollPortal.TaxTooHigh.selector);
        portal.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Greedy Troll",
                symbol: "GREED",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: 1_001, // just over MAX_TAX_BPS (1_000 = 10%)
                sellTaxBps: 100
            })
        );
    }

    /// @notice Bounds on startingMarketCapQuote (audit finding M-2): below
    /// ~$54 in 6-decimal USDC, the token1-ordering price math used to
    /// overflow uint256 with an opaque revert — but only when the launch
    /// token happened to sort as currency1, so the SAME market cap could
    /// succeed or fail depending on an address the creator doesn't control.
    /// MIN_STARTING_MC_QUOTE now rejects anything in the danger zone with a
    /// clean, address-ordering-independent error instead.
    function test_StartingMcOutOfBoundsIsRejected() public {
        // Computed up front, not inline in the call below: vm.expectRevert
        // only intercepts the very next external call, and
        // `portal.MIN_STARTING_MC_QUOTE()` is itself an external staticcall
        // — inlining it as an argument expression would let expectRevert
        // catch that read instead of the createLaunch call it's meant to
        // guard.
        uint256 minMc = portal.MIN_STARTING_MC_QUOTE();
        uint256 maxMc = portal.MAX_STARTING_MC_QUOTE();

        vm.prank(creator);
        vm.expectRevert(TrollPortal.StartingMcOutOfRange.selector);
        portal.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Zero Troll",
                symbol: "ZERO",
                startingMarketCapQuote: 0,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );

        vm.prank(creator);
        vm.expectRevert(TrollPortal.StartingMcOutOfRange.selector);
        portal.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Almost Zero Troll",
                symbol: "ALMOST",
                startingMarketCapQuote: minMc - 1,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );

        vm.prank(creator);
        vm.expectRevert(TrollPortal.StartingMcOutOfRange.selector);
        portal.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Too Big Troll",
                symbol: "HUGE",
                startingMarketCapQuote: maxMc + 1,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );

        // The boundary value itself succeeds.
        vm.prank(creator);
        portal.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Minimum Troll",
                symbol: "MIN",
                startingMarketCapQuote: minMc,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );
    }

    // ------------------------------------------------------------------
    // LP fee harvesting — permissionless, routes through the same splitter
    // ------------------------------------------------------------------

    function test_HarvestFeesCollectsPoolFeesAndSplitsThem() public {
        (address token, address locker) = _createLaunch(portal, 0, 0); // isolate pool-fee harvesting from hook tax
        PoolKey memory key = _keyFor(token);
        address splitter = TrollLocker(locker).splitter();

        _buy(trader1, token, key, 300 * USDC_DECIMALS);
        uint256 tokenBal = TrollLaunchToken(token).balanceOf(trader1);
        _sell(trader1, token, key, tokenBal / 2);

        uint256 creditedBefore0 = TrollRevenueSplitter(splitter).creditedToCreator(token);
        uint256 creditedBefore1 = TrollRevenueSplitter(splitter).creditedToCreator(address(usdc));

        TrollLocker(locker).harvestFees();

        uint256 creditedAfter0 = TrollRevenueSplitter(splitter).creditedToCreator(token);
        uint256 creditedAfter1 = TrollRevenueSplitter(splitter).creditedToCreator(address(usdc));
        assertTrue(
            creditedAfter0 > creditedBefore0 || creditedAfter1 > creditedBefore1,
            "harvesting real trading activity should produce some LP fees to split"
        );
    }

    // ------------------------------------------------------------------
    // TrollTreasury — plain, owner-only, no automation of any kind
    // ------------------------------------------------------------------

    function test_TreasuryAccumulatesAndOnlyOwnerCanWithdraw() public {
        (address token, address locker) = _createLaunch(portal, 100, 100);
        PoolKey memory key = _keyFor(token);
        address splitter = TrollLocker(locker).splitter();

        _buy(trader1, token, key, 200 * USDC_DECIMALS);
        TrollLocker(locker).harvestFees();
        hook.flush(key); // moves the hook's accrued swap tax into the splitter

        // Revenue is credited but not yet pushed anywhere (pull-based, per
        // the H-2 fix) — the treasury only receives it once claimPlatform
        // is actually called. Anyone may call it.
        assertEq(usdc.balanceOf(address(treasury)), 0, "treasury should hold nothing until claimPlatform is called");
        TrollRevenueSplitter(splitter).claimPlatform(address(usdc));

        uint256 treasuryTokenBal = TrollLaunchToken(token).balanceOf(address(treasury));
        uint256 treasuryUsdcBal = usdc.balanceOf(address(treasury));
        // Token-side LP fees now route to TOKEN_FEE_SINK, not the treasury
        // (L-6 fix) — the treasury should hold ONLY USDC, never the launch
        // token, confirming TrollTreasury's "plain USDC" premise actually
        // holds post-fix.
        assertEq(treasuryTokenBal, 0, "treasury must never hold the launch token");
        assertGt(treasuryUsdcBal, 0, "treasury should have accumulated some platform cut in USDC");

        vm.prank(trader2);
        vm.expectRevert(TrollTreasury.NotOwner.selector);
        treasury.withdraw(address(usdc), trader2, 1);

        vm.prank(treasuryOwner);
        treasury.withdraw(address(usdc), treasuryOwner, treasuryUsdcBal);
        assertEq(usdc.balanceOf(treasuryOwner), treasuryUsdcBal, "owner should be able to withdraw the accumulated cut");
    }

    // ------------------------------------------------------------------
    // Pad factory: "a pad that launches pads" (docs/PAD-FACTORY.md)
    // White-label pads: Troll takes 15%, the pad owner picks their share,
    // creators split the rest by their own fee allocation (up to 5 wallets
    // plus buyback & burn). House pads (Troll Pad itself): Troll takes 10%.
    // ------------------------------------------------------------------

    address padBuyer = makeAddr("padBuyer");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function _settings(uint16 ownerShareBps, uint16 maxTaxBps, uint256 launchFee, uint256 minMc)
        internal
        pure
        returns (PadPortal.PadSettings memory)
    {
        return PadPortal.PadSettings({
            padOwnerShareBps: ownerShareBps,
            minTaxBps: 0,
            maxTaxBps: maxTaxBps,
            launchFee: launchFee,
            minStartingMarketCapQuote: minMc,
            launchesPaused: false,
            inviteOnly: false,
            maxStartingMarketCapQuote: 1_000_000_000_000e6 // no cap unless a test sets one
        });
    }

    function _solo(address who) internal pure returns (PadPortal.FeeAllocation memory a) {
        a.recipients = new address[](1);
        a.recipients[0] = who;
        a.recipientBps = new uint16[](1);
        a.recipientBps[0] = 10_000;
    }

    function _params(uint16 buyTaxBps, uint16 sellTaxBps) internal pure returns (PadPortal.CreateLaunchParams memory) {
        return PadPortal.CreateLaunchParams({
            name: "Pad Troll", symbol: "PTROLL", startingMarketCapQuote: STARTING_MC, buyTaxBps: buyTaxBps, sellTaxBps: sellTaxBps
        });
    }

    function _deployPad(PadPortal.PadSettings memory s) internal returns (PadPortal pad) {
        vm.startPrank(customer);
        usdc.approve(address(factory), SETUP_FEE);
        pad = PadPortal(factory.deployPad("MoonPad", s, SETUP_FEE));
        vm.stopPrank();
    }

    function _padLaunchWith(PadPortal pad, address who, PadPortal.FeeAllocation memory alloc, uint16 buyTaxBps, uint16 sellTaxBps)
        internal
        returns (address token, PadRevenueSplitter splitter)
    {
        (uint16 share,,, uint256 fee,,,,) = pad.settings();
        vm.startPrank(who);
        if (fee > 0) usdc.approve(address(pad), fee);
        (token,) = pad.createLaunch(_params(buyTaxBps, sellTaxBps), alloc, share, fee);
        vm.stopPrank();
        splitter = PadRevenueSplitter(pad.splitterForToken(token));
    }

    function _padLaunch(PadPortal pad, address who, uint16 buyTaxBps, uint16 sellTaxBps)
        internal
        returns (address token, PadRevenueSplitter splitter)
    {
        return _padLaunchWith(pad, who, _solo(who), buyTaxBps, sellTaxBps);
    }

    function _tradeAndFlush(address token) internal returns (uint256 revenue) {
        PoolKey memory key = _keyFor(token);
        uint256 got = _buy(trader1, token, key, 300 * USDC_DECIMALS);
        _sell(trader1, token, key, got);
        revenue = hook.pendingTax(PoolId.unwrap(key.toId()));
        hook.flush(key);
    }

    function test_Pad_DeployChargesSetupFeeAndWiresThePad() public {
        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));

        assertTrue(factory.isPad(address(pad)));
        assertFalse(factory.isHousePad(address(pad)));
        assertEq(factory.padCount(), 1);
        assertEq(pad.padOwner(), customer, "buyer owns the pad");
        assertEq(pad.factory(), factory.padPortalTemplate(), "a standard pad is built by template #1");
        assertEq(PadPortalTemplate(pad.factory()).factory(), address(factory));
        assertEq(factory.templateOf(address(pad)), factory.padPortalTemplate());
        assertEq(pad.platformShareBps(), 1_500, "Troll takes 15% on white-label pads");
        assertEq(pad.maxPadOwnerShareBps(), 8_500);
        assertTrue(hook.isAuthorizedPortal(address(pad)), "the hook trusts the new pad");
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + SETUP_FEE, "$100 setup fee to the treasury");
        (uint16 share,, uint16 maxTax, uint256 fee, uint256 minMc,,,) = pad.settings();
        assertEq(share, 2_000);
        assertEq(maxTax, 1_000);
        assertEq(fee, 0);
        assertEq(minMc, 100e6);
    }

    function test_Pad_HousePadTakesTenPercentAndIsOwnerOnly() public {
        vm.prank(customer);
        vm.expectRevert(TrollPadFactory.NotOwner.selector);
        factory.deployHousePad("Fake Troll Pad", customer, _settings(0, 1_000, 0, 100e6));

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        PadPortal house = PadPortal(factory.deployHousePad("Troll Pad", address(this), _settings(0, 1_000, 0, 100e6)));
        assertTrue(factory.isHousePad(address(house)));
        assertEq(house.platformShareBps(), 1_000);
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore, "no setup fee for a house pad");

        (address token, PadRevenueSplitter sp) = _padLaunch(house, creator, 300, 300);
        uint256 revenue = _tradeAndFlush(token);
        assertEq(sp.platformCredit(), (revenue * 1_000) / 10_000, "Troll: 10%");
        assertEq(sp.padOwnerCredit(), 0);
        assertEq(sp.creditOf(creator), revenue - (revenue * 1_000) / 10_000, "creator: 90%");
    }

    function test_Pad_BuyerIsProtectedFromASetupFeeRaise() public {
        factory.setSetupFee(200e6);
        vm.startPrank(customer);
        usdc.approve(address(factory), 200e6);
        vm.expectRevert(TrollPadFactory.FeeChanged.selector);
        factory.deployPad("MoonPad", _settings(0, 1_000, 0, 100e6), SETUP_FEE); // agreed to pay $100 at most
        vm.stopPrank();
    }

    function test_Pad_SetupFeeIsOwnerOnlyAndBounded() public {
        vm.prank(customer);
        vm.expectRevert(TrollPadFactory.NotOwner.selector);
        factory.setSetupFee(1);
        vm.expectRevert(TrollPadFactory.ZeroFee.selector);
        factory.setSetupFee(0);
        vm.expectRevert(TrollPadFactory.FeeTooHigh.selector);
        factory.setSetupFee(10_000e6 + 1);
        factory.setSetupFee(250e6);
        assertEq(factory.setupFee(), 250e6);

        factory.transferOwnership(customer);
        assertEq(factory.owner(), address(this), "two-step: nothing changes until accepted");
        vm.prank(customer);
        factory.acceptOwnership();
        assertEq(factory.owner(), customer);
        vm.expectRevert(TrollPadFactory.NotOwner.selector);
        factory.setSetupFee(100e6);
    }

    function test_Pad_RevenueSplitsFifteenToTrollPadOwnerShareRestToCreator() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6)); // pad owner keeps 20%
        (address token, PadRevenueSplitter sp) = _padLaunch(pad, creator, 300, 300);
        uint256 revenue = _tradeAndFlush(token);
        assertGt(revenue, 0);

        uint256 platform = (revenue * 1_500) / 10_000;
        uint256 padOwnerCut = (revenue * 2_000) / 10_000;
        assertEq(sp.platformCredit(), platform, "Troll: 15%");
        assertEq(sp.padOwnerCredit(), padOwnerCut, "pad owner: their 20%");
        assertEq(sp.creditOf(creator), revenue - platform - padOwnerCut, "creator: the other 65%");

        uint256 ownerBefore = usdc.balanceOf(customer);
        assertEq(pad.pendingPadOwnerFees(0, 10), padOwnerCut);
        pad.claimPadOwnerFees(0, 10); // anyone may trigger it; the money goes to the pad owner
        assertEq(usdc.balanceOf(customer), ownerBefore + padOwnerCut);
        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        pad.claimPlatformFees(0, 10);
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + platform);
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        sp.claim(creator, address(usdc));
        assertEq(usdc.balanceOf(creator), creatorBefore + revenue - platform - padOwnerCut);
        assertEq(pad.claimPadOwnerFees(0, 10), 0, "a second sweep finds nothing and doesn't revert");
        assertEq(pad.claimPlatformFees(0, 10), 0);
    }

    function test_Pad_OwnerMayKeepAllOf85ButNotMore() public {
        PadPortal pad = _deployPad(_settings(8_500, 1_000, 0, 100e6));
        (address token, PadRevenueSplitter sp) = _padLaunch(pad, creator, 500, 500);
        uint256 revenue = _tradeAndFlush(token);
        assertEq(sp.platformCredit(), (revenue * 1_500) / 10_000, "Troll still gets 15%");
        assertEq(sp.padOwnerCredit(), (revenue * 8_500) / 10_000);
        assertLe(sp.creditOf(creator), 1, "creator gets only rounding dust at an 85% pad");

        vm.prank(customer);
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(8_501, 1_000, 0, 100e6));
    }

    function test_Pad_LaunchFeeSplitsFifteenEightyFiveUpToOneThousand() public {
        PadPortal pad = _deployPad(_settings(0, 1_000, 500e6, 100e6)); // $500 launch fee
        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        uint256 ownerBefore = usdc.balanceOf(customer);
        uint256 creatorBefore = usdc.balanceOf(creator);
        _padLaunch(pad, creator, 100, 100);
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + 75e6, "Troll: 15% of $500");
        assertEq(usdc.balanceOf(customer), ownerBefore + 425e6, "pad owner: 85% of $500");
        assertEq(usdc.balanceOf(creator), creatorBefore - 500e6);

        vm.startPrank(customer);
        pad.setSettings(_settings(0, 1_000, 1_000e6, 100e6)); // $1,000 is allowed
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(0, 1_000, 1_000e6 + 1, 100e6));
        vm.stopPrank();
    }

    function test_Pad_CreatorIsProtectedFromTermsChangedUnderThem() public {
        PadPortal pad = _deployPad(_settings(1_000, 1_000, 10e6, 100e6));
        vm.prank(customer);
        pad.setSettings(_settings(5_000, 1_000, 10e6, 100e6)); // owner raises their cut
        vm.startPrank(creator);
        usdc.approve(address(pad), 100e6);
        vm.expectRevert(PadPortal.TermsChanged.selector);
        pad.createLaunch(_params(100, 100), _solo(creator), 1_000, 10e6); // creator agreed to 10%
        vm.stopPrank();

        vm.prank(customer);
        pad.setSettings(_settings(1_000, 1_000, 60e6, 100e6)); // owner raises the launch fee
        vm.prank(creator);
        vm.expectRevert(PadPortal.TermsChanged.selector);
        pad.createLaunch(_params(100, 100), _solo(creator), 1_000, 10e6);
    }

    function test_Pad_TaxRangeAndMinMarketCapAreEnforced() public {
        PadPortal.PadSettings memory s = _settings(0, 300, 0, 1_000e6); // "1–3% tax, min $1k MC" pad
        s.minTaxBps = 100;
        PadPortal pad = _deployPad(s);
        vm.startPrank(creator);
        vm.expectRevert(PadPortal.TaxTooHigh.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 1_000e6, 400, 100), _solo(creator), 0, 0);
        vm.expectRevert(PadPortal.TaxTooLow.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 1_000e6, 100, 50), _solo(creator), 0, 0);
        vm.expectRevert(PadPortal.StartingMcOutOfRange.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 999e6, 300, 300), _solo(creator), 0, 0);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 1_000e6, 300, 100), _solo(creator), 0, 0);
        vm.stopPrank();
        assertEq(pad.launchCount(), 1);

        vm.startPrank(customer);
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(0, 1_001, 0, 100e6)); // 10% is the ceiling everywhere
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(0, 1_000, 0, 99e6)); // $100 is the floor everywhere
        PadPortal.PadSettings memory bad = _settings(0, 200, 0, 100e6);
        bad.minTaxBps = 300; // min above max
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(bad);
        vm.stopPrank();
    }

    /// Troll Pad deploys with a $10k cap (owner: no launch opens above a
    /// $10k market cap); every pad owner sets their own cap.
    function test_Pad_MaxStartingMarketCapIsEnforced() public {
        PadPortal.PadSettings memory s = _settings(0, 1_000, 0, 100e6);
        s.maxStartingMarketCapQuote = 10_000e6;
        PadPortal pad = _deployPad(s);
        vm.startPrank(creator);
        vm.expectRevert(PadPortal.StartingMcOutOfRange.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("Too Big", "BIG", 10_000e6 + 1, 300, 300), _solo(creator), 0, 0);
        vm.expectRevert(PadPortal.StartingMcOutOfRange.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("Way Big", "WAY", 1_000_000e6, 300, 300), _solo(creator), 0, 0);
        pad.createLaunch(PadPortal.CreateLaunchParams("Just Right", "OK", 10_000e6, 300, 300), _solo(creator), 0, 0);
        pad.createLaunch(PadPortal.CreateLaunchParams("Tiny", "TINY", 100e6, 300, 300), _solo(creator), 0, 0);
        vm.stopPrank();
        assertEq(pad.launchCount(), 2);
        (,,,,,,, uint256 maxMc) = pad.settings();
        assertEq(maxMc, 10_000e6);
    }

    function test_Pad_MaxStartingMarketCapMustBeValid() public {
        PadPortal pad = _deployPad(_settings(0, 1_000, 0, 1_000e6));
        vm.startPrank(customer);
        PadPortal.PadSettings memory s = _settings(0, 1_000, 0, 1_000e6);
        s.maxStartingMarketCapQuote = 999e6; // below the pad's own minimum
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(s);
        s.maxStartingMarketCapQuote = 1_000_000_000_000e6 + 1; // above the $1T ceiling
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(s);
        s.maxStartingMarketCapQuote = 1_000e6; // min == max: one fixed opening market cap
        pad.setSettings(s);
        vm.stopPrank();
        vm.prank(creator);
        vm.expectRevert(PadPortal.StartingMcOutOfRange.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 1_001e6, 300, 300), _solo(creator), 0, 0);
        vm.prank(creator);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 1_000e6, 300, 300), _solo(creator), 0, 0);
    }

    function test_Pad_PauseStopsNewLaunchesButNeverTrading() public {
        PadPortal pad = _deployPad(_settings(1_000, 1_000, 0, 100e6));
        (address token,) = _padLaunch(pad, creator, 100, 100);
        PadPortal.PadSettings memory s = _settings(1_000, 1_000, 0, 100e6);
        s.launchesPaused = true;
        vm.prank(customer);
        pad.setSettings(s);

        vm.prank(trader2);
        vm.expectRevert(PadPortal.LaunchesPaused.selector);
        pad.createLaunch(_params(100, 100), _solo(trader2), 1_000, 0);

        PoolKey memory key = _keyFor(token);
        uint256 got = _buy(trader1, token, key, 20 * USDC_DECIMALS);
        assertGt(_sell(trader1, token, key, got), 0, "existing tokens trade normally while launches are paused");
    }

    function test_Pad_InviteOnlyOnlyLetsApprovedWalletsLaunch() public {
        PadPortal.PadSettings memory s = _settings(1_000, 1_000, 0, 100e6);
        s.inviteOnly = true;
        PadPortal pad = _deployPad(s);

        vm.prank(creator);
        vm.expectRevert(PadPortal.NotApproved.selector);
        pad.createLaunch(_params(100, 100), _solo(creator), 1_000, 0);

        address[] memory list = new address[](1);
        list[0] = creator;
        vm.prank(trader1);
        vm.expectRevert(PadPortal.NotPadOwner.selector);
        pad.setApprovedCreators(list, true);
        vm.prank(customer);
        pad.setApprovedCreators(list, true);

        _padLaunch(pad, creator, 100, 100);
        assertEq(pad.launchCount(), 1);
    }

    function test_Pad_SettingsChangesOnlyAffectFutureLaunches() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));
        (, PadRevenueSplitter first) = _padLaunch(pad, creator, 100, 100);
        vm.prank(customer);
        pad.setSettings(_settings(5_000, 1_000, 0, 100e6));
        (, PadRevenueSplitter second) = _padLaunch(pad, trader2, 100, 100);
        assertEq(first.padOwnerShareBps(), 2_000, "first launch keeps the 20% it launched with");
        assertEq(second.padOwnerShareBps(), 5_000);
    }

    function test_Pad_OnlyThePadOwnerControlsThePad() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));
        vm.startPrank(creator);
        vm.expectRevert(PadPortal.NotPadOwner.selector);
        pad.setSettings(_settings(8_500, 1_000, 0, 100e6));
        vm.expectRevert(PadPortal.NotPadOwner.selector);
        pad.transferPadOwnership(creator);
        vm.stopPrank();
    }

    function test_Pad_OwnershipTransferMovesSettingsAndPayouts() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));
        (address token, PadRevenueSplitter sp) = _padLaunch(pad, creator, 300, 300);
        _tradeAndFlush(token);
        uint256 owed = sp.padOwnerCredit();

        vm.prank(customer);
        pad.transferPadOwnership(padBuyer);
        assertEq(pad.padOwner(), customer, "two-step: nothing changes until accepted");
        vm.prank(padBuyer);
        pad.acceptPadOwnership();
        assertEq(pad.padOwner(), padBuyer);

        pad.claimPadOwnerFees(0, 1);
        assertEq(usdc.balanceOf(padBuyer), owed, "unclaimed pad earnings follow the pad");
        vm.prank(customer);
        vm.expectRevert(PadPortal.NotPadOwner.selector);
        pad.setSettings(_settings(0, 1_000, 0, 100e6));
    }

    function test_Pad_NoTradingRestrictions() public {
        PadPortal pad = _deployPad(_settings(8_500, 1_000, 0, 100e6));
        (address token,) = _padLaunch(pad, creator, 1_000, 1_000);
        PoolKey memory key = _keyFor(token);
        uint256 got = _buy(trader1, token, key, 50 * USDC_DECIMALS); // launch block
        assertGt(got, 0);
        vm.prank(trader1);
        TrollLaunchToken(token).transfer(trader2, got / 2); // free wallet-to-wallet transfer
        assertEq(TrollLaunchToken(token).balanceOf(trader2), got / 2);
        assertGt(_sell(trader2, token, key, got / 2), 0, "sell straight back");
        assertGt(_sell(trader1, token, key, TrollLaunchToken(token).balanceOf(trader1)), 0);
    }

    function test_Pad_FeeAllocationSplitsAcrossWalletsAndIsLocked() public {
        PadPortal pad = _deployPad(_settings(1_000, 1_000, 0, 100e6)); // pad owner 10%, Troll 15%: creators share 75%
        address dev = makeAddr("dev");
        address mkt = makeAddr("mkt");
        address team = makeAddr("team");
        PadPortal.FeeAllocation memory a;
        a.recipients = new address[](3);
        a.recipients[0] = dev;
        a.recipients[1] = mkt;
        a.recipients[2] = team;
        a.recipientBps = new uint16[](3);
        a.recipientBps[0] = 5_000;
        a.recipientBps[1] = 3_000;
        a.recipientBps[2] = 2_000;
        (address token, PadRevenueSplitter sp) = _padLaunchWith(pad, creator, a, 400, 400);
        uint256 revenue = _tradeAndFlush(token);

        uint256 pool = revenue - (revenue * 1_500) / 10_000 - (revenue * 1_000) / 10_000;
        uint256 mktCut = (pool * 3_000) / 10_000;
        uint256 teamCut = (pool * 2_000) / 10_000;
        assertEq(sp.creditOf(mkt), mktCut);
        assertEq(sp.creditOf(team), teamCut);
        assertEq(sp.creditOf(dev), pool - mktCut - teamCut, "first wallet gets 50% plus rounding dust");

        sp.distribute(); // anyone can pay everyone
        assertEq(usdc.balanceOf(dev), pool - mktCut - teamCut);
        assertEq(usdc.balanceOf(mkt), mktCut);
        assertEq(usdc.balanceOf(team), teamCut);

        // A wallet can move its own slot, nobody else can; percentages never change.
        address newMkt = makeAddr("newMkt");
        vm.prank(dev);
        vm.expectRevert(PadRevenueSplitter.NotAuthorized.selector);
        sp.updateRecipient(1, dev);
        vm.prank(mkt);
        sp.updateRecipient(1, newMkt);
        (address[] memory r, uint16[] memory bps, uint16 buyback) = sp.allocation();
        assertEq(r[1], newMkt);
        assertEq(bps[1], 3_000);
        assertEq(buyback, 0);
    }

    function test_Pad_FeeAllocationMustBeValid() public {
        PadPortal pad = _deployPad(_settings(0, 1_000, 0, 100e6));
        PadPortal.FeeAllocation memory a = _solo(creator);
        a.recipientBps[0] = 9_000; // adds up to 90%
        vm.prank(creator);
        vm.expectRevert(PadRevenueSplitter.InvalidAllocation.selector);
        pad.createLaunch(_params(100, 100), a, 0, 0);

        PadPortal.FeeAllocation memory six;
        six.recipients = new address[](6);
        six.recipientBps = new uint16[](6);
        for (uint256 i; i < 6; i++) {
            six.recipients[i] = address(uint160(0x1000 + i));
            six.recipientBps[i] = i == 0 ? 5_000 : 1_000;
        }
        vm.prank(creator);
        vm.expectRevert(PadRevenueSplitter.InvalidAllocation.selector);
        pad.createLaunch(_params(100, 100), six, 0, 0); // at most 5 wallets

        PadPortal.FeeAllocation memory zero = _solo(address(0));
        vm.prank(creator);
        vm.expectRevert(PadRevenueSplitter.ZeroAddress.selector);
        pad.createLaunch(_params(100, 100), zero, 0, 0);
    }

    function test_Pad_BuybackAndBurn() public {
        PadPortal pad = _deployPad(_settings(0, 1_000, 0, 100e6));
        PadPortal.FeeAllocation memory a = _solo(creator);
        a.recipientBps[0] = 6_000;
        a.buybackBps = 4_000; // 40% of the creator's share buys back and burns the token
        (address token, PadRevenueSplitter sp) = _padLaunchWith(pad, creator, a, 500, 500);
        // Keep some buyers in the pool so there is something to buy back into.
        PoolKey memory key = _keyFor(token);
        _buy(trader2, token, key, 500 * USDC_DECIMALS);
        uint256 revenue = _tradeAndFlush(token);

        uint256 pool = revenue - (revenue * 1_500) / 10_000;
        uint256 bucket = (pool * 4_000) / 10_000;
        assertEq(sp.buybackCredit(), bucket);
        assertEq(sp.creditOf(creator), pool - bucket);

        vm.prank(trader1);
        vm.expectRevert(PadRevenueSplitter.NotAuthorized.selector);
        sp.executeBuyback(bucket, 0); // only the creator can trigger it
        vm.prank(creator);
        vm.expectRevert(PadRevenueSplitter.InvalidAmount.selector);
        sp.executeBuyback(bucket + 1, 0);
        vm.prank(creator);
        vm.expectRevert(PadRevenueSplitter.Slippage.selector);
        sp.executeBuyback(bucket, type(uint256).max);

        uint256 deadBefore = TrollLaunchToken(token).balanceOf(DEAD);
        uint256 creditBefore = sp.creditOf(creator);
        vm.prank(creator);
        uint256 burned = sp.executeBuyback(bucket, 1);
        assertGt(burned, 0);
        assertEq(TrollLaunchToken(token).balanceOf(DEAD), deadBefore + burned, "bought tokens went to the dead address");
        assertEq(sp.buybackCredit(), 0);
        assertEq(sp.totalBurned(), burned);
        assertEq(sp.totalBuybackSpent(), bucket);
        assertEq(sp.creditOf(creator), creditBefore, "the buyback never touches the wallets' share");
        assertGt(hook.pendingTax(PoolId.unwrap(key.toId())), 0, "the buyback paid normal buy tax like any trade");
    }

    function test_Pad_SplitterCannotBeReinitialized() public {
        PadRevenueSplitter.InitParams memory ip;
        vm.expectRevert(PadRevenueSplitter.AlreadyInitialized.selector);
        splitterImpl.initialize(ip); // the implementation itself is sealed
        PadPortal pad = _deployPad(_settings(0, 1_000, 0, 100e6));
        (, PadRevenueSplitter sp) = _padLaunch(pad, creator, 100, 100);
        vm.expectRevert(PadRevenueSplitter.AlreadyInitialized.selector);
        sp.initialize(ip); // and so is every clone
    }

    /// @notice A blocklisted pad owner can only block their own payout: never
    /// trading, the hook's flush, the creator's claim or Troll's share.
    function test_Pad_BlockedPadOwnerOnlyBlocksTheirOwnPayout() public {
        BlockableERC20 q = new BlockableERC20();
        q.mint(trader1, 100_000 * USDC_DECIMALS);
        q.mint(customer, 100_000 * USDC_DECIMALS);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (, bytes32 salt) =
            HookMiner.find(address(this), flags, type(TrollHook).creationCode, abi.encode(address(manager), address(this)));
        TrollHook h = new TrollHook{salt: salt}(address(manager), address(this));
        TrollPadFactory f = new TrollPadFactory(
            address(manager), address(h), address(treasury), address(q), address(splitterImpl), SETUP_FEE, address(this)
        );
        h.bootstrapFactory(address(f));

        vm.startPrank(customer);
        q.approve(address(f), SETUP_FEE);
        PadPortal pad = PadPortal(f.deployPad("BlockPad", _settings(3_000, 1_000, 0, 100e6), SETUP_FEE));
        vm.stopPrank();
        vm.prank(creator);
        (address token,) = pad.createLaunch(
            PadPortal.CreateLaunchParams("Blk", "BLK", STARTING_MC, 200, 200), _solo(creator), 3_000, 0
        );
        PadRevenueSplitter sp = PadRevenueSplitter(pad.splitterForToken(token));

        q.setBlocked(customer, true); // the pad owner gets blocklisted

        bool tokenIsToken0 = token < address(q);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : address(q)),
            currency1: Currency.wrap(tokenIsToken0 ? address(q) : token),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(h))
        });
        vm.startPrank(trader1);
        q.approve(address(swapRouter), 200 * USDC_DECIMALS);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !tokenIsToken0,
                amountSpecified: -int256(200 * USDC_DECIMALS),
                sqrtPriceLimitX96: !tokenIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        h.flush(key); // still works
        assertGt(sp.padOwnerCredit(), 0);
        vm.expectRevert(BlockableERC20.RecipientBlocked.selector);
        pad.claimPadOwnerFees(0, 1); // only this reverts
        vm.prank(creator);
        sp.claim(creator, address(q)); // creator unaffected
        pad.claimPlatformFees(0, 1); // Troll unaffected
        assertGt(q.balanceOf(creator), 0);
    }

    // ------------------------------------------------------------------
    // H-2 regression: a blocklisted revenue recipient can only ever block
    // its own claim, never a swap.
    // ------------------------------------------------------------------

    /// @notice Direct regression test for Fable's H-2 finding: the pre-fix
    /// hook pushed tax to the splitter, which pushed the platform's cut on
    /// to the treasury, INSIDE the swap itself — so a single blocklisted
    /// address anywhere in that chain (e.g. Circle blocklisting the
    /// treasury on a real USDC-like token) would have permanently reverted
    /// every swap on every pool forever, since PoolConfig is immutable.
    /// Deploys a dedicated hook/portal pair using a quote token that can
    /// block a specific recipient's incoming transfers, blocks the
    /// treasury, and proves: swaps still succeed, `flush` still succeeds
    /// (it only ever pays the splitter), and only the treasury's own
    /// `claimPlatform` call reverts — the creator's own claim is
    /// completely unaffected.
    function test_BlockedTreasuryCannotBrickSwapsOnlyItsOwnClaim() public {
        BlockableERC20 blockableQuote = new BlockableERC20();
        blockableQuote.mint(trader1, 100_000 * USDC_DECIMALS);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory creationCode = type(TrollHook).creationCode;
        bytes memory constructorArgs = abi.encode(address(manager), address(this));
        // Re-mining with identical (deployer, flags, initCode) inputs to
        // setUp()'s hook naturally lands on a DIFFERENT salt here —
        // HookMiner.find skips any candidate address that already has
        // code, and setUp()'s hook already occupies the first match.
        (address predictedHook, bytes32 salt) = HookMiner.find(address(this), flags, creationCode, constructorArgs);
        TrollHook freshHook = new TrollHook{salt: salt}(address(manager), address(this));
        require(address(freshHook) == predictedHook, "hook address mismatch");

        TrollTreasury blockedTreasury = new TrollTreasury(treasuryOwner);
        TrollPortal freshPortal =
            new TrollPortal(address(manager), address(freshHook), address(blockedTreasury), address(blockableQuote), true);
        freshHook.bootstrapMainPortal(address(freshPortal));

        // Block the treasury's INCOMING transfers only — simulating e.g. a
        // real blocklisting event on the quote asset.
        blockableQuote.setBlocked(address(blockedTreasury), true);

        vm.prank(creator);
        (address token, address locker) = freshPortal.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Blocked Quote Troll",
                symbol: "BLOCK",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );
        bool tokenIsToken0 = token < address(blockableQuote);
        PoolKey memory key = PoolKey({
            currency0: tokenIsToken0 ? Currency.wrap(token) : Currency.wrap(address(blockableQuote)),
            currency1: tokenIsToken0 ? Currency.wrap(address(blockableQuote)) : Currency.wrap(token),
            fee: freshPortal.POOL_FEE(),
            tickSpacing: freshPortal.TICK_SPACING(),
            hooks: IHooks(address(freshHook))
        });

        // The swap itself must succeed even though the treasury is
        // blocked — tax moves purely through internal ERC-6909 claims
        // during a swap, never an external transfer to the treasury.
        bool zeroForOne = !tokenIsToken0; // giving quote, receiving token
        vm.startPrank(trader1);
        blockableQuote.approve(address(swapRouter), 200 * USDC_DECIMALS);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(200 * USDC_DECIMALS),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        address splitter = TrollLocker(locker).splitter();

        // flush() also succeeds — it only ever pays the splitter, never the
        // treasury directly.
        freshHook.flush(key);
        assertGt(
            TrollRevenueSplitter(splitter).creditedToPlatform(address(blockableQuote)),
            0,
            "platform should have been credited its cut despite the treasury being blocked"
        );

        // Only the platform's OWN claim, to the blocked treasury, reverts.
        vm.expectRevert();
        TrollRevenueSplitter(splitter).claimPlatform(address(blockableQuote));

        // The creator's claim is completely unaffected by the treasury
        // being blocked — pull-based accounting means one broken recipient
        // can never block another's funds.
        uint256 creatorCredited = TrollRevenueSplitter(splitter).creditedToCreator(address(blockableQuote));
        assertGt(creatorCredited, 0, "creator should still be credited");
        vm.prank(creator);
        TrollRevenueSplitter(splitter).claim(creator, address(blockableQuote));
        assertEq(blockableQuote.balanceOf(creator), creatorCredited, "creator's claim should succeed despite the treasury being blocked");
    }

    // ------------------------------------------------------------ pad templates

    function _mockTemplate(address quote) internal returns (MockPadTemplate t) {
        t = new MockPadTemplate(address(manager), address(hook), address(treasury), quote, address(splitterImpl));
    }

    function _deployFromTemplate(address template, PadPortal.PadSettings memory s) internal returns (PadPortal pad) {
        vm.startPrank(customer);
        usdc.approve(address(factory), SETUP_FEE);
        pad = PadPortal(factory.deployPadFromTemplate(template, "ForkPad", abi.encode(s), SETUP_FEE));
        vm.stopPrank();
    }

    function test_Template_OnlyTheOwnerApprovesAndOnlyContracts() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        vm.prank(customer);
        vm.expectRevert(TrollPadFactory.NotOwner.selector);
        factory.setTemplateApproved(address(t), true);
        vm.expectRevert(TrollPadFactory.InvalidTemplate.selector);
        factory.setTemplateApproved(makeAddr("eoa"), true);

        factory.setTemplateApproved(address(t), true);
        assertTrue(factory.isApprovedTemplate(address(t)));
        factory.setTemplateApproved(address(t), false);
        assertFalse(factory.isApprovedTemplate(address(t)));
    }

    function test_Template_UnapprovedTemplateCannotBuildPads() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        vm.startPrank(customer);
        usdc.approve(address(factory), SETUP_FEE);
        vm.expectRevert(TrollPadFactory.TemplateNotApproved.selector);
        factory.deployPadFromTemplate(address(t), "Nope", abi.encode(_settings(0, 1_000, 0, 100e6)), SETUP_FEE);
        vm.stopPrank();
    }

    function test_Template_BuiltInTemplateOnlyServesItsFactory() public {
        PadPortalTemplate t = PadPortalTemplate(factory.padPortalTemplate());
        assertEq(t.factory(), address(factory));
        assertEq(t.hook(), address(hook));
        assertEq(t.treasury(), address(treasury));
        vm.expectRevert(PadPortalTemplate.NotFactory.selector);
        t.deployPortal(customer, 0, abi.encode(_settings(0, 1_000, 0, 100e6)));
        assertFalse(factory.isApprovedTemplate(address(t)), "deployPad uses it directly; it isn't on the list");
    }

    /// The point of templates: a new kind of pad on the same hook, here one
    /// whose coins are paired against another token instead of USDC (the
    /// Fork Wars idea). Same $100 USDC setup fee, same 15% to Troll, paid in
    /// that pad's own quote token.
    function test_Template_NewKindOfPadQuotedInAnotherToken() public {
        MockERC20 parent = new MockERC20("Parent Coin", "PARENT", 6);
        parent.mint(trader1, 100_000 * USDC_DECIMALS);
        MockPadTemplate t = _mockTemplate(address(parent));
        factory.setTemplateApproved(address(t), true);

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        PadPortal pad = _deployFromTemplate(address(t), _settings(2_000, 1_000, 0, 100e6));
        assertTrue(factory.isPad(address(pad)));
        assertFalse(factory.isHousePad(address(pad)));
        assertEq(factory.templateOf(address(pad)), address(t));
        assertTrue(hook.isAuthorizedPortal(address(pad)));
        assertEq(pad.padOwner(), customer);
        assertEq(pad.platformShareBps(), 1_500);
        assertEq(pad.quoteAsset(), address(parent));
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + SETUP_FEE, "setup fee still in USDC");

        vm.prank(creator);
        (address token,) =
            pad.createLaunch(PadPortal.CreateLaunchParams("Fork", "FORK", STARTING_MC, 300, 300), _solo(creator), 2_000, 0);
        PadRevenueSplitter sp = PadRevenueSplitter(pad.splitterForToken(token));

        bool tokenIsToken0 = token < address(parent);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : address(parent)),
            currency1: Currency.wrap(tokenIsToken0 ? address(parent) : token),
            fee: pad.POOL_FEE(),
            tickSpacing: pad.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
        vm.startPrank(trader1);
        parent.approve(address(swapRouter), 200 * USDC_DECIMALS);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !tokenIsToken0,
                amountSpecified: -int256(200 * USDC_DECIMALS),
                sqrtPriceLimitX96: !tokenIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertGt(TrollLaunchToken(token).balanceOf(trader1), 0, "bought the fork with the parent coin");

        uint256 revenue = hook.pendingTax(PoolId.unwrap(key.toId()));
        assertEq(revenue, (200 * USDC_DECIMALS * 300) / 10_000, "3% buy tax, in the parent coin");
        hook.flush(key);
        assertEq(sp.platformCredit(), (revenue * 1_500) / 10_000, "Troll: 15%");
        assertEq(sp.padOwnerCredit(), (revenue * 2_000) / 10_000, "pad owner: 20%");
        pad.claimPlatformFees(0, 10);
        assertEq(parent.balanceOf(address(treasury)), (revenue * 1_500) / 10_000, "treasury paid in the parent coin");
    }

    function test_Template_HousePadIsOwnerOnlyAndTakesTenPercent() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        factory.setTemplateApproved(address(t), true);
        bytes memory cfg = abi.encode(_settings(0, 1_000, 0, 100e6));
        vm.prank(customer);
        vm.expectRevert(TrollPadFactory.NotOwner.selector);
        factory.deployHousePadFromTemplate(address(t), "Fake", customer, cfg);
        vm.expectRevert(TrollPadFactory.ZeroAddress.selector);
        factory.deployHousePadFromTemplate(address(t), "House", address(0), cfg);

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        PadPortal house = PadPortal(factory.deployHousePadFromTemplate(address(t), "House Fork", address(this), cfg));
        assertTrue(factory.isHousePad(address(house)));
        assertEq(house.platformShareBps(), 1_000);
        assertEq(house.padOwner(), address(this));
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore, "no setup fee");
    }

    function test_Template_HousePadNeedsAnApprovedTemplateToo() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        vm.expectRevert(TrollPadFactory.TemplateNotApproved.selector);
        factory.deployHousePadFromTemplate(address(t), "House", address(this), abi.encode(_settings(0, 1_000, 0, 100e6)));
    }

    /// PadPortal refuses a zero owner itself, so this uses a template that
    /// returns a bare pad-shaped contract: only the factory's own check can
    /// stop a pad nobody owns.
    function test_Template_PadWithNoOwnerIsRejected() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        factory.setTemplateApproved(address(t), true);
        t.setMode(MockPadTemplate.Mode.FakePad, address(0));
        vm.expectRevert(TrollPadFactory.ZeroAddress.selector);
        factory.deployHousePadFromTemplate(address(t), "House", address(0), "");
    }

    function test_Template_BuyerIsProtectedFromASetupFeeRaise() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        factory.setTemplateApproved(address(t), true);
        factory.setSetupFee(200e6);
        vm.startPrank(customer);
        usdc.approve(address(factory), 200e6);
        vm.expectRevert(TrollPadFactory.FeeChanged.selector);
        factory.deployPadFromTemplate(address(t), "ForkPad", abi.encode(_settings(0, 1_000, 0, 100e6)), SETUP_FEE);
        vm.stopPrank();
    }

    /// Even an approved template can't slip in a pad on another hook,
    /// PoolManager or treasury, charging less than Troll's share, owned by
    /// someone else, already registered, or not a contract at all.
    function test_Template_MiswiredPadsAreRejected() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        factory.setTemplateApproved(address(t), true);
        PadPortal existing = _deployPad(_settings(0, 1_000, 0, 100e6));
        bytes memory cfg = abi.encode(_settings(0, 1_000, 0, 100e6));

        MockPadTemplate.Mode[7] memory bad = [
            MockPadTemplate.Mode.WrongHook,
            MockPadTemplate.Mode.WrongManager,
            MockPadTemplate.Mode.WrongTreasury,
            MockPadTemplate.Mode.WrongShare,
            MockPadTemplate.Mode.WrongOwner,
            MockPadTemplate.Mode.ReturnExisting,
            MockPadTemplate.Mode.ReturnNoCode
        ];
        uint256 customerBefore = usdc.balanceOf(customer);
        uint256 padsBefore = factory.padCount();
        for (uint256 i; i < bad.length; i++) {
            t.setMode(bad[i], address(existing));
            vm.startPrank(customer);
            usdc.approve(address(factory), SETUP_FEE);
            vm.expectRevert(TrollPadFactory.InvalidPortal.selector);
            factory.deployPadFromTemplate(address(t), "Bad", cfg, SETUP_FEE);
            vm.stopPrank();
        }
        assertEq(usdc.balanceOf(customer), customerBefore, "a rejected pad costs the buyer nothing");
        assertEq(factory.padCount(), padsBefore);
    }

    function test_Template_RevokingStopsNewPadsButNotExistingOnes() public {
        MockPadTemplate t = _mockTemplate(address(usdc));
        factory.setTemplateApproved(address(t), true);
        PadPortal pad = _deployFromTemplate(address(t), _settings(0, 1_000, 0, 100e6));
        factory.setTemplateApproved(address(t), false);

        vm.startPrank(customer);
        usdc.approve(address(factory), SETUP_FEE);
        vm.expectRevert(TrollPadFactory.TemplateNotApproved.selector);
        factory.deployPadFromTemplate(address(t), "Late", abi.encode(_settings(0, 1_000, 0, 100e6)), SETUP_FEE);
        vm.stopPrank();

        (address token,) = _padLaunch(pad, creator, 300, 300);
        assertGt(_tradeAndFlush(token), 0, "the existing pad still launches and trades");
    }
}

/// @dev Minimal ERC-20 that can block a specific address's INCOMING
/// transfers — stands in for a real blocklisting event (e.g. Circle
/// freezing an address on USDC) to test H-2's fix in isolation.
contract BlockableERC20 is MockERC20 {
    mapping(address => bool) public blocked;

    error RecipientBlocked();

    constructor() MockERC20("Blockable Quote", "BLKQ", 6) {}

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (blocked[to]) revert RecipientBlocked();
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (blocked[to]) revert RecipientBlocked();
        return super.transferFrom(from, to, amount);
    }
}

/// @dev A pad template for the factory tests: builds a PadPortal with a
/// chosen quote asset, or, in the bad modes, one wired wrong.
contract MockPadTemplate is IPadTemplate {
    enum Mode {
        Ok,
        WrongHook,
        WrongManager,
        WrongTreasury,
        WrongShare,
        WrongOwner,
        ReturnExisting,
        ReturnNoCode,
        FakePad
    }

    address immutable manager;
    address immutable hook;
    address immutable treasury;
    address immutable quote;
    address immutable splitterImpl;
    Mode public mode;
    address public existing;

    constructor(address manager_, address hook_, address treasury_, address quote_, address splitterImpl_) {
        manager = manager_;
        hook = hook_;
        treasury = treasury_;
        quote = quote_;
        splitterImpl = splitterImpl_;
    }

    function setMode(Mode m, address existing_) external {
        mode = m;
        existing = existing_;
    }

    function deployPortal(address padOwner, uint16 platformShareBps, bytes calldata config) external returns (address) {
        if (mode == Mode.ReturnExisting) return existing;
        if (mode == Mode.ReturnNoCode) return address(0xdead0001);
        if (mode == Mode.FakePad) return address(new FakePad(manager, hook, treasury, platformShareBps, padOwner));
        PadPortal.PadSettings memory s = abi.decode(config, (PadPortal.PadSettings));
        address beef = address(0xBEEF);
        return address(
            new PadPortal(
                mode == Mode.WrongManager ? beef : manager,
                mode == Mode.WrongHook ? beef : hook,
                mode == Mode.WrongTreasury ? beef : treasury,
                quote,
                splitterImpl,
                mode == Mode.WrongShare ? 0 : platformShareBps,
                mode == Mode.WrongOwner ? beef : padOwner,
                s
            )
        );
    }
}

/// @dev Not a PadPortal: only the views the factory checks, so a test can
/// hand the factory a "pad" PadPortal's own constructor would refuse.
contract FakePad {
    address public poolManager;
    address public hook;
    address public treasury;
    uint16 public platformShareBps;
    address public padOwner;

    constructor(address poolManager_, address hook_, address treasury_, uint16 platformShareBps_, address padOwner_) {
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        platformShareBps = platformShareBps_;
        padOwner = padOwner_;
    }
}
