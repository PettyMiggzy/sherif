// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "@uniswap/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {TrollPortal} from "../src/TrollPortal.sol";
import {TrollHook} from "../src/TrollHook.sol";
import {TrollRevenueSplitter} from "../src/TrollRevenueSplitter.sol";
import {TrollLocker} from "../src/TrollLocker.sol";
import {TrollLaunchToken} from "../src/TrollLaunchToken.sol";
import {TrollPadFactory} from "../src/TrollPadFactory.sol";
import {PadRevenueSplitter} from "../src/PadRevenueSplitter.sol";
import {TrollTreasury} from "../src/TrollTreasury.sol";

/// @dev Stand-in USDC. Deployed with deployCodeTo at a chosen address so a
/// test can force either pool orientation (token below or above quote).
contract TestUSDC is MockERC20 {
    constructor() MockERC20("USD Coin", "USDC", 6) {}
}

/// @notice Regression tests for the 2026-09-24 adversarial audit
/// (docs/AUDIT-2026-09-24.md). Every tax assertion is exact, and each shape
/// runs in both orientations — the gaps tests-spec-6 found in TrollPad.t.sol.
contract AuditFixesTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 constant STARTING_MC = 500e6;
    uint16 constant BUY_BPS = 300;
    uint16 constant SELL_BPS = 700;
    address constant LOW_QUOTE = address(0x0000000000000000000000000000000000001000);
    address constant HIGH_QUOTE = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);

    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address attacker = makeAddr("attacker");

    struct Env {
        MockERC20 quote;
        TrollHook hook;
        TrollPortal portal;
        TrollTreasury treasury;
        address token;
        address locker;
        address splitter;
        PoolKey key;
        bool tokenIsToken0;
    }

    function setUp() public {
        deployFreshManagerAndRouters();
    }

    function _hook() internal returns (TrollHook h) {
        bytes memory args = abi.encode(address(manager), address(this));
        (address predicted, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(TrollHook).creationCode, args);
        h = new TrollHook{salt: salt}(address(manager), address(this));
        require(address(h) == predicted, "hook address mismatch");
    }

    /// @dev Fresh quote/hook/portal and one launch. `quoteAt` picks the
    /// orientation: LOW_QUOTE puts the token at currency1, HIGH_QUOTE at currency0.
    function _launch(address quoteAt) internal returns (Env memory e) {
        deployCodeTo("AuditFixes.t.sol:TestUSDC", quoteAt);
        e.quote = MockERC20(quoteAt);
        e.hook = _hook();
        e.treasury = new TrollTreasury(makeAddr("treasuryOwner"));
        e.portal = new TrollPortal(address(manager), address(e.hook), address(e.treasury), quoteAt, true);
        e.hook.bootstrapMainPortal(address(e.portal));

        vm.prank(creator);
        (e.token, e.locker) = e.portal.createLaunch(
            TrollPortal.CreateLaunchParams({
                name: "Audit Troll",
                symbol: "AUDIT",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: BUY_BPS,
                sellTaxBps: SELL_BPS
            })
        );
        e.splitter = TrollLocker(e.locker).splitter();
        e.tokenIsToken0 = e.token < quoteAt;
        e.key = PoolKey({
            currency0: Currency.wrap(e.tokenIsToken0 ? e.token : quoteAt),
            currency1: Currency.wrap(e.tokenIsToken0 ? quoteAt : e.token),
            fee: e.portal.POOL_FEE(),
            tickSpacing: e.portal.TICK_SPACING(),
            hooks: IHooks(address(e.hook))
        });
        assertEq(e.tokenIsToken0, quoteAt == HIGH_QUOTE, "orientation not forced as intended");

        e.quote.mint(trader, 1_000_000e6);
        vm.startPrank(trader);
        e.quote.approve(address(swapRouter), type(uint256).max);
        TrollLaunchToken(e.token).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Swaps as `trader`; returns the trader's (quote, token) deltas,
    /// positive = received.
    function _swap(Env memory e, bool isBuy, int256 amountSpecified) internal returns (int256 quoteDelta, int256 tokenDelta) {
        bool zeroForOne = isBuy ? !e.tokenIsToken0 : e.tokenIsToken0;
        vm.prank(trader);
        BalanceDelta d = swapRouter.swap(
            e.key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        quoteDelta = e.tokenIsToken0 ? d.amount1() : d.amount0();
        tokenDelta = e.tokenIsToken0 ? d.amount0() : d.amount1();
    }

    function _pending(Env memory e) internal view returns (uint256) {
        return e.hook.pendingTax(PoolId.unwrap(e.key.toId()));
    }

    function _grossUp(uint256 net, uint256 bps) internal pure returns (uint256) {
        return (net * bps + (10_000 - bps) - 1) / (10_000 - bps);
    }

    // ------------------------------------------------------------------
    // hook-3 / tests-spec-6: every swap shape, both orientations, exact tax
    // ------------------------------------------------------------------

    function _allShapes(address quoteAt) internal {
        Env memory e = _launch(quoteAt);

        // Exact-in buy: 3% of the USDC sent.
        uint256 p0 = _pending(e);
        (int256 q,) = _swap(e, true, -int256(1_000e6));
        assertEq(q, -int256(1_000e6), "exact-in buy should take exactly the amount sent");
        assertEq(_pending(e) - p0, (1_000e6 * uint256(BUY_BPS)) / 10_000, "exact-in buy tax");

        // Exact-in sell: 7% of the gross USDC the pool pays out.
        uint256 bal = TrollLaunchToken(e.token).balanceOf(trader);
        p0 = _pending(e);
        (q,) = _swap(e, false, -int256(bal / 4));
        uint256 tax = _pending(e) - p0;
        uint256 received = uint256(q);
        assertEq(tax, ((received + tax) * SELL_BPS) / 10_000, "exact-in sell tax");

        // Exact-out buy: tax grossed up so it's 3% of everything the buyer pays.
        p0 = _pending(e);
        (q,) = _swap(e, true, int256(1_000_000 ether));
        tax = _pending(e) - p0;
        uint256 paid = uint256(-q);
        assertEq(tax, _grossUp(paid - tax, BUY_BPS), "exact-out buy tax");
        assertApproxEqAbs(tax * 10_000, paid * BUY_BPS, 10_000, "exact-out buy should pay 3% of gross, not t/(1+t)");

        // Exact-out sell: seller gets exactly 10 USDC; tax is 7% of the gross.
        p0 = _pending(e);
        (q,) = _swap(e, false, int256(10e6));
        assertEq(q, int256(10e6), "exact-out sell should deliver exactly the amount asked for");
        tax = _pending(e) - p0;
        assertEq(tax, _grossUp(10e6, SELL_BPS), "exact-out sell tax");
        assertApproxEqAbs(tax * 10_000, (10e6 + tax) * SELL_BPS, 10_000, "exact-out sell should pay 7% of gross");

        // Flush: exactly 10% to the platform, 90% to the creator, all in quote.
        uint256 total = _pending(e);
        e.hook.flush(e.key);
        uint256 platform = (total * 1_000) / 10_000;
        assertEq(TrollRevenueSplitter(e.splitter).creditedToPlatform(quoteAt), platform, "main pad platform share");
        assertEq(TrollRevenueSplitter(e.splitter).creditedToCreator(quoteAt), total - platform, "creator share");
        assertEq(TrollRevenueSplitter(e.splitter).creditedToCreator(e.token), 0, "never credited in the launch token");
        assertEq(TrollLaunchToken(e.token).balanceOf(e.splitter), 0, "splitter never holds the launch token");
        assertEq(e.quote.balanceOf(e.splitter), total, "splitter holds exactly what it credited");
    }

    function test_ExactTaxAllShapes_TokenIsCurrency1() public {
        _allShapes(LOW_QUOTE);
    }

    function test_ExactTaxAllShapes_TokenIsCurrency0() public {
        _allShapes(HIGH_QUOTE);
    }

    // ------------------------------------------------------------------
    // portal-1 / portal-2: opens at the position edge, no free price push
    // ------------------------------------------------------------------

    function _opensAtEdgeAndBlocksFreePush(address quoteAt) internal {
        Env memory e = _launch(quoteAt);
        (uint160 sqrtBefore, int24 tick,,) = manager.getSlot0(e.key.toId());
        int24 edge = e.tokenIsToken0 ? TrollLocker(e.locker).tickLower() : TrollLocker(e.locker).tickUpper();
        assertEq(tick, edge, "pool should open exactly at the position's near edge");

        // Selling before any buy has nothing to fill: the swap would only
        // move the price across empty ticks, so the hook rejects it.
        deal(e.token, attacker, 1 ether);
        vm.startPrank(attacker);
        TrollLaunchToken(e.token).approve(address(swapRouter), type(uint256).max);
        bool zeroForOne = e.tokenIsToken0;
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(e.hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(TrollHook.NoLiquidityToFill.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        swapRouter.swap(
            e.key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1 ether,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        (uint160 sqrtAfter,,,) = manager.getSlot0(e.key.toId());
        assertEq(sqrtAfter, sqrtBefore, "price must not move");

        // The very first buy fills immediately — no empty gap to cross.
        (, int256 tok) = _swap(e, true, -int256(1e6));
        assertGt(tok, 0, "a $1 first buy should receive tokens");
    }

    function test_OpensAtEdgeAndBlocksFreePush_TokenIsCurrency1() public {
        _opensAtEdgeAndBlocksFreePush(LOW_QUOTE);
    }

    function test_OpensAtEdgeAndBlocksFreePush_TokenIsCurrency0() public {
        _opensAtEdgeAndBlocksFreePush(HIGH_QUOTE);
    }

    // ------------------------------------------------------------------
    // hook-1: only the launch's locker can add liquidity
    // ------------------------------------------------------------------

    function test_ThirdPartyRangeOrderIsRejected() public {
        Env memory e = _launch(LOW_QUOTE);
        _swap(e, true, -int256(1_000e6)); // give the attacker a price to place orders around

        (, int24 tick,,) = manager.getSlot0(e.key.toId());
        int24 spacing = e.key.tickSpacing;
        int24 base = (tick / spacing) * spacing;
        deal(e.token, attacker, 1_000_000 ether);
        e.quote.mint(attacker, 1_000e6);
        vm.startPrank(attacker);
        TrollLaunchToken(e.token).approve(address(modifyLiquidityRouter), type(uint256).max);
        e.quote.approve(address(modifyLiquidityRouter), type(uint256).max);
        // A one-sided range just past the price on either side: a limit
        // order that other people's swaps would fill with no tax.
        int24[2] memory lowers = [base + 2 * spacing, base - 3 * spacing];
        for (uint256 i; i < 2; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    CustomRevert.WrappedError.selector,
                    address(e.hook),
                    IHooks.beforeAddLiquidity.selector,
                    abi.encodeWithSelector(TrollHook.LiquidityLocked.selector),
                    abi.encodeWithSelector(Hooks.HookCallFailed.selector)
                )
            );
            modifyLiquidityRouter.modifyLiquidity(
                e.key,
                IPoolManager.ModifyLiquidityParams({
                    tickLower: lowers[i], tickUpper: lowers[i] + spacing, liquidityDelta: 1e18, salt: bytes32(0)
                }),
                ""
            );
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // hook-2: a quote-specified swap that can't fill in full is rejected
    // ------------------------------------------------------------------

    function test_PartialFillOfTaxedExactInBuyReverts() public {
        Env memory e = _launch(HIGH_QUOTE); // token is currency0; a buy is oneForZero, price rises
        (uint160 sqrtNow,,,) = manager.getSlot0(e.key.toId());
        uint160 limit = uint160((uint256(sqrtNow) * 1_001) / 1_000); // ~0.2% above: stops a big buy early
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(e.hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(TrollHook.PartialFillUnsupported.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        swapRouter.swap(
            e.key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -int256(10_000e6), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ------------------------------------------------------------------
    // factory-trust-1/2: the factory slot and pool registration
    // ------------------------------------------------------------------

    function test_BootstrapFactoryRejectsNonFactoriesAndMiswiredFactories() public {
        TrollHook h = _hook();
        vm.expectRevert(TrollHook.InvalidFactory.selector);
        h.bootstrapFactory(makeAddr("eoa"));

        TrollHook other = _hook();
        TrollPadFactory wrong =
            new TrollPadFactory(address(manager), address(other), makeAddr("treasury"), address(1), address(new PadRevenueSplitter()), 100e6, address(this));
        vm.expectRevert(TrollHook.InvalidFactory.selector);
        h.bootstrapFactory(address(wrong));

        TrollPadFactory right =
            new TrollPadFactory(address(manager), address(h), makeAddr("treasury"), address(1), address(new PadRevenueSplitter()), 100e6, address(this));
        h.bootstrapFactory(address(right));
        assertEq(h.factory(), address(right));
    }

    function test_RenounceClosesTheFactorySlotForGood() public {
        TrollHook h = _hook();
        vm.prank(attacker);
        vm.expectRevert(TrollHook.NotBootstrapper.selector);
        h.renounceFactoryBootstrap();

        h.renounceFactoryBootstrap();
        assertTrue(h.factoryBootstrapped());
        assertEq(h.factory(), address(0));

        TrollPadFactory f =
            new TrollPadFactory(address(manager), address(h), makeAddr("treasury"), address(1), address(new PadRevenueSplitter()), 100e6, address(this));
        vm.expectRevert(TrollHook.AlreadyBootstrapped.selector);
        h.bootstrapFactory(address(f));
    }

    function test_FactoryConstructorRejectsBadWiring() public {
        TrollHook h = _hook();
        address impl = address(new PadRevenueSplitter());
        vm.expectRevert(TrollPadFactory.HookMismatch.selector);
        new TrollPadFactory(makeAddr("otherManager"), address(h), makeAddr("t"), address(1), impl, 100e6, address(this));
        vm.expectRevert(TrollPadFactory.FeeTooHigh.selector);
        new TrollPadFactory(address(manager), address(h), makeAddr("t"), address(1), impl, 100e18, address(this));
        vm.expectRevert(TrollPadFactory.ZeroAddress.selector);
        new TrollPadFactory(address(manager), address(h), address(0), address(1), impl, 100e6, address(this));
        vm.expectRevert(TrollPadFactory.ZeroAddress.selector); // a splitter implementation with no code
        new TrollPadFactory(address(manager), address(h), makeAddr("t"), address(1), makeAddr("noCode"), 100e6, address(this));
    }

    function test_PortalCannotRegisterAPoolItDidNotInitialize() public {
        Env memory e = _launch(LOW_QUOTE);
        PoolKey memory squat = e.key;
        squat.currency1 = Currency.wrap(makeAddr("predictedNextToken")); // some other pool on this hook
        vm.prank(address(e.portal)); // authorized, but never initialized this key
        vm.expectRevert(TrollHook.NotInitializer.selector);
        e.hook.registerPool(squat, e.splitter, e.locker, LOW_QUOTE, false, 100, 100);
    }

    // ------------------------------------------------------------------
    // Design rule: no trading restrictions (owner decision, 2026-09-24).
    // No anti-snipe window, max-buy, max-wallet, cooldown, blacklist or
    // pause — the things token scanners (GoPlus, honeypot.is,
    // TokenSniffer) flag. This is the profile a scanner simulates: buy in
    // the launch block, sell everything straight back, move tokens freely.
    // ------------------------------------------------------------------

    function _scannerProfile(address quoteAt) internal {
        Env memory e = _launch(quoteAt); // same block as the launch

        // A big buy in the launch block goes through — no snipe window, no max buy.
        (, int256 bought) = _swap(e, true, -int256(50_000e6));
        assertGt(bought, 0);
        assertGt(uint256(bought), 1e27 / 2, "one buyer may take most of the supply; no max-wallet");

        // Selling the whole bag straight back works in the same block — no cooldown, not a honeypot.
        uint256 bal = TrollLaunchToken(e.token).balanceOf(trader);
        (int256 got,) = _swap(e, false, -int256(bal));
        assertGt(got, 0, "sell-all must succeed");
        assertEq(TrollLaunchToken(e.token).balanceOf(trader), 0);

        // Wallet-to-wallet transfers are plain ERC-20: no tax, no restriction.
        (, int256 again) = _swap(e, true, -int256(10e6));
        address friend = makeAddr("friend");
        vm.prank(trader);
        TrollLaunchToken(e.token).transfer(friend, uint256(again));
        assertEq(TrollLaunchToken(e.token).balanceOf(friend), uint256(again), "transfers are never taxed");
    }

    function test_NoTradingRestrictions_TokenIsCurrency1() public {
        _scannerProfile(LOW_QUOTE);
    }

    function test_NoTradingRestrictions_TokenIsCurrency0() public {
        _scannerProfile(HIGH_QUOTE);
    }

    // ------------------------------------------------------------------
    // splitter-treasury-3: stray funds are recoverable; no self-claim
    // ------------------------------------------------------------------

    function test_SweepSurplusCreditsStrayQuoteAndSelfClaimIsRejected() public {
        Env memory e = _launch(LOW_QUOTE);
        e.quote.mint(e.splitter, 1_000e6); // e.g. someone mistook the splitter for a pay-in address

        TrollRevenueSplitter(e.splitter).sweepSurplus(LOW_QUOTE);
        assertEq(TrollRevenueSplitter(e.splitter).creditedToPlatform(LOW_QUOTE), 100e6);
        assertEq(TrollRevenueSplitter(e.splitter).creditedToCreator(LOW_QUOTE), 900e6);

        vm.expectRevert(TrollRevenueSplitter.NothingToClaim.selector);
        TrollRevenueSplitter(e.splitter).sweepSurplus(LOW_QUOTE);

        vm.prank(creator);
        vm.expectRevert(TrollRevenueSplitter.InvalidRecipient.selector);
        TrollRevenueSplitter(e.splitter).claim(e.splitter, LOW_QUOTE);
    }
}
