// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobinHook} from "../src/RobinHook.sol";
import {RobinPortal} from "../src/RobinPortal.sol";
import {RobinLocker} from "../src/RobinLocker.sol";
import {RobinRevenueSplitter} from "../src/RobinRevenueSplitter.sol";
import {PadPortal} from "../src/PadPortal.sol";
import {PadRevenueSplitter} from "../src/PadRevenueSplitter.sol";
import {RobinHolderToken} from "../src/RobinHolderToken.sol";
import {RobinhoodStack} from "../script/RobinhoodStack.sol";

/// @notice The whole pad on REAL Robinhood Chain state: the live Uniswap v4
/// PoolManager and real USDG, deployed by the same routine the deploy script
/// runs (RobinhoodStack). Ports Arc's three fork tests (ForkArc,
/// ForkPadFactory, ForkHolderPad), minus Arc's native-USDC precompile stubs:
/// USDG is a plain ERC-20, funded with `deal`. Skipped unless
/// ROBINHOOD_FORK_URL is set:
///   ROBINHOOD_FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract ForkRobinhoodTest -vv
contract ForkRobinhoodTest is Test, RobinhoodStack {
    using PoolIdLibrary for PoolKey;

    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    Stack s;
    PoolSwapTest router;

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("ROBINHOOD_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url);
        assertEq(block.chainid, 4663, "not a Robinhood Chain fork");
        s = _deployStack(address(this), address(this), 100e6, "Robin Labs Pad");
        router = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        return true;
    }

    function _fund(address who, uint256 amount) internal {
        deal(USDG, who, amount);
        assertEq(IERC20(USDG).balanceOf(who), amount, "deal() could not set a USDG balance");
    }

    function _key(address token) internal view returns (PoolKey memory k, bool tokenIsToken0) {
        tokenIsToken0 = token < USDG;
        k = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : USDG),
            currency1: Currency.wrap(tokenIsToken0 ? USDG : token),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(s.hook))
        });
    }

    function _approveRouter(address who, address token) internal {
        vm.startPrank(who);
        IERC20(USDG).approve(address(router), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _swap(address who, PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        vm.prank(who);
        router.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _solo(address who) internal pure returns (PadPortal.FeeAllocation memory a) {
        a.recipients = new address[](1);
        a.recipients[0] = who;
        a.recipientBps = new uint16[](1);
        a.recipientBps[0] = 10_000;
    }

    // ── Arc's ForkArc: the main portal, a whole launch, paid out in real USDG ──

    function test_MainPortalLaunchTradeFlushClaim() public {
        if (!_fork()) return;
        address creator = makeAddr("creator");
        address trader = makeAddr("trader");

        vm.prank(creator);
        (address token, address locker) = s.mainPortal.createLaunch(
            RobinPortal.CreateLaunchParams({
                name: "Fork Robin", symbol: "FROB", startingMarketCapQuote: 1_000e6, buyTaxBps: 300, sellTaxBps: 300
            })
        );
        assertEq(IERC20(token).totalSupply(), 1_000_000_000 ether);
        assertEq(IERC20(token).balanceOf(locker) + IERC20(token).balanceOf(POOL_MANAGER), 1_000_000_000 ether);

        (PoolKey memory key, bool tokenIsToken0) = _key(token);
        bytes32 id = PoolId.unwrap(key.toId());
        _fund(trader, 1_000e6);
        _approveRouter(trader, token);

        _swap(trader, key, !tokenIsToken0, 100e6); // buy $100
        uint256 bought = IERC20(token).balanceOf(trader);
        assertGt(bought, 0, "bought nothing");
        assertEq(hook().pendingTax(id), 3e6, "buy tax is exactly 3% of $100, in USDG");
        assertEq(IERC20(USDG).balanceOf(trader), 900e6, "paid exactly $100");

        _swap(trader, key, tokenIsToken0, bought); // sell it all back
        assertEq(IERC20(token).balanceOf(trader), 0, "sold everything");
        uint256 pending = hook().pendingTax(id);
        assertGt(pending, 3e6, "the sell added its own tax, also in USDG");

        hook().flush(key);
        RobinRevenueSplitter sp = RobinRevenueSplitter(RobinLocker(locker).splitter());
        uint256 creatorCut = sp.creditedToCreator(USDG);
        assertEq(creatorCut, pending - (pending * 1_000) / 10_000, "90% to the creator");
        vm.prank(creator);
        sp.claim(creator, USDG);
        assertEq(IERC20(USDG).balanceOf(creator), creatorCut, "creator paid in real USDG");

        uint256 t0 = IERC20(USDG).balanceOf(address(s.treasury));
        sp.claimPlatform(USDG);
        assertEq(IERC20(USDG).balanceOf(address(s.treasury)), t0 + pending - creatorCut, "platform's 10% reached the treasury");

        // The treasury owner can withdraw it.
        address to = makeAddr("ops");
        s.treasury.withdraw(USDG, to, pending - creatorCut);
        assertEq(IERC20(USDG).balanceOf(to), pending - creatorCut);

        // Third parties still can't add liquidity on the real PoolManager.
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(IPoolManager(POOL_MANAGER));
        vm.expectRevert();
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -887200, tickUpper: 887200, liquidityDelta: 1e12, salt: 0}),
            ""
        );
    }

    // ── New for this port: USDG sorts at 0x5f…, Arc's USDC at 0x36…, so the
    // share of coins that land as currency0 changes. Prove both pricing
    // branches open, trade and tax correctly against real USDG. ──

    function test_BothTokenOrderingsTradeAgainstRealUSDG() public {
        if (!_fork()) return;
        address creator = makeAddr("creator");
        address trader = makeAddr("trader");
        _fund(trader, 10_000e6);

        bool sawToken0;
        bool sawToken1;
        for (uint256 i; i < 24 && !(sawToken0 && sawToken1); ++i) {
            vm.prank(creator);
            (address token,) = s.mainPortal.createLaunch(
                RobinPortal.CreateLaunchParams({
                    name: "Order", symbol: "ORD", startingMarketCapQuote: 5_000e6, buyTaxBps: 500, sellTaxBps: 200
                })
            );
            (PoolKey memory key, bool tokenIsToken0) = _key(token);
            if (tokenIsToken0 ? sawToken0 : sawToken1) continue;
            if (tokenIsToken0) sawToken0 = true;
            else sawToken1 = true;

            bytes32 id = PoolId.unwrap(key.toId());
            _approveRouter(trader, token);
            uint256 u0 = IERC20(USDG).balanceOf(trader);
            _swap(trader, key, !tokenIsToken0, 200e6);
            assertEq(u0 - IERC20(USDG).balanceOf(trader), 200e6, "buy spent exactly $200");
            assertEq(hook().pendingTax(id), 10e6, "5% buy tax = $10, in USDG, either ordering");

            uint256 bal = IERC20(token).balanceOf(trader);
            u0 = IERC20(USDG).balanceOf(trader);
            _swap(trader, key, tokenIsToken0, bal);
            uint256 gotBack = IERC20(USDG).balanceOf(trader) - u0;
            assertGt(gotBack, 0, "sell returned USDG");
            assertLt(gotBack, 200e6, "round trip is never profitable");
            uint256 sellTax = hook().pendingTax(id) - 10e6;
            // Exact-in sell: 2% of the gross USDG out, net paid to the seller.
            assertApproxEqAbs(sellTax, ((gotBack + sellTax) * 200) / 10_000, 1, "2% sell tax, in USDG");
        }
        assertTrue(sawToken0 && sawToken1, "did not reach both orderings");
    }

    // ── Arc's ForkPadFactory: buy a white-label pad, launch on it, split fees ──

    function test_WhiteLabelPadLifecycle() public {
        if (!_fork()) return;
        address padOwner = makeAddr("padOwner");
        address creator = makeAddr("creator");
        address trader = makeAddr("trader");
        _fund(padOwner, 1_000e6);
        _fund(creator, 1_000e6);
        _fund(trader, 1_000e6);

        // Buy a pad: $100, pad owner keeps 25%, $20 launch fee, max 5% tax.
        uint256 treasuryBefore = IERC20(USDG).balanceOf(address(s.treasury));
        PadPortal.PadSettings memory st = PadPortal.PadSettings({
            padOwnerShareBps: 2_500,
            minTaxBps: 0,
            maxTaxBps: 500,
            launchFee: 20e6,
            minStartingMarketCapQuote: 500e6,
            launchesPaused: false,
            inviteOnly: false,
            maxStartingMarketCapQuote: 1_000_000_000_000e6
        });
        vm.startPrank(padOwner);
        IERC20(USDG).approve(address(s.factory), 100e6);
        PadPortal pad = PadPortal(s.factory.deployPad("Fork Pad", st, 100e6));
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(address(s.treasury)), treasuryBefore + 100e6, "setup fee reached the treasury");
        assertTrue(hook().isAuthorizedPortal(address(pad)));

        // Launch on it, paying the $20 launch fee (15% platform / 85% pad owner).
        uint256 ownerBefore = IERC20(USDG).balanceOf(padOwner);
        PadPortal.FeeAllocation memory alloc;
        alloc.recipients = new address[](1);
        alloc.recipients[0] = creator;
        alloc.recipientBps = new uint16[](1);
        alloc.recipientBps[0] = 7_000;
        alloc.buybackBps = 3_000;
        vm.startPrank(creator);
        IERC20(USDG).approve(address(pad), 20e6);
        (address token,) = pad.createLaunch(
            PadPortal.CreateLaunchParams({
                name: "Fork Pad Robin", symbol: "FPR", startingMarketCapQuote: 1_000e6, buyTaxBps: 500, sellTaxBps: 500
            }),
            alloc,
            2_500,
            20e6
        );
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(padOwner), ownerBefore + 17e6, "pad owner got 85% of the launch fee");
        assertEq(IERC20(USDG).balanceOf(address(s.treasury)), treasuryBefore + 103e6, "platform got 15% of the launch fee");

        (PoolKey memory key, bool tokenIsToken0) = _key(token);
        _approveRouter(trader, token);
        _swap(trader, key, !tokenIsToken0, 100e6);
        uint256 bought = IERC20(token).balanceOf(trader);
        assertEq(hook().pendingTax(PoolId.unwrap(key.toId())), 5e6, "buy tax: exactly 5% of $100");
        _swap(trader, key, tokenIsToken0, bought / 2);

        uint256 revenue = hook().pendingTax(PoolId.unwrap(key.toId()));
        hook().flush(key);
        PadRevenueSplitter sp = PadRevenueSplitter(pad.splitterForToken(token));
        uint256 platform = (revenue * 1_500) / 10_000;
        uint256 ownerCut = (revenue * 2_500) / 10_000;
        uint256 creatorPool = revenue - platform - ownerCut;
        uint256 bucket = (creatorPool * 3_000) / 10_000;
        assertEq(sp.platformCredit(), platform);
        assertEq(sp.padOwnerCredit(), ownerCut);
        assertEq(sp.buybackCredit(), bucket);
        assertEq(sp.creditOf(creator), creatorPool - bucket);

        // Buyback & burn through the real PoolManager with USDG.
        vm.prank(creator);
        uint256 burned = sp.executeBuyback(bucket, 1);
        assertGt(burned, 0);
        assertEq(IERC20(token).balanceOf(DEAD), burned, "burned");

        ownerBefore = IERC20(USDG).balanceOf(padOwner);
        pad.claimPadOwnerFees(0, 10);
        assertEq(IERC20(USDG).balanceOf(padOwner), ownerBefore + ownerCut, "pad owner paid in USDG");
        uint256 t0 = IERC20(USDG).balanceOf(address(s.treasury));
        pad.claimPlatformFees(0, 10);
        assertEq(IERC20(USDG).balanceOf(address(s.treasury)), t0 + platform, "platform's 15% reached the treasury");
        uint256 c0 = IERC20(USDG).balanceOf(creator);
        vm.prank(creator);
        sp.claim(creator, USDG);
        assertEq(IERC20(USDG).balanceOf(creator), c0 + creatorPool - bucket, "creator's wallet paid its 70%");

        // Both hook slots are closed for good.
        vm.expectRevert(RobinHook.AlreadyBootstrapped.selector);
        hook().bootstrapFactory(address(s.factory));
        vm.expectRevert(RobinHook.AlreadyBootstrapped.selector);
        hook().bootstrapMainPortal(address(pad));
    }

    // ── Arc's ForkHolderPad: the house pad, holders paid dividends in USDG ──

    function test_HolderDividendsOnTheHousePad() public {
        if (!_fork()) return;
        address creator = makeAddr("creator");
        address team = makeAddr("team");
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);

        (,,,,,,, uint256 maxMc) = s.housePad.settings();
        assertEq(maxMc, 10_000e6, "house pad caps the opening market cap at $10k");

        // Creator 50%, team 20%, holders 20%, buyback 10%; 5% tax.
        PadPortal.FeeAllocation memory a;
        a.recipients = new address[](2);
        a.recipients[0] = creator;
        a.recipients[1] = team;
        a.recipientBps = new uint16[](2);
        a.recipientBps[0] = 5_000;
        a.recipientBps[1] = 2_000;
        a.buybackBps = 1_000;
        vm.prank(creator);
        (address t,) = s.housePad.createLaunchWithHolders(
            PadPortal.CreateLaunchParams({
                name: "Fork Holders", symbol: "FHOLD", startingMarketCapQuote: 5_000e6, buyTaxBps: 500, sellTaxBps: 500
            }),
            a,
            2_000,
            0,
            0
        );
        RobinHolderToken token = RobinHolderToken(t);
        PadRevenueSplitter sp = PadRevenueSplitter(s.housePad.splitterForToken(t));
        (address[] memory r,,) = sp.allocation();
        assertEq(r[2], t, "holders' slot pays the token");

        (PoolKey memory key, bool tokenIsToken0) = _key(t);
        _approveRouter(alice, t);
        _approveRouter(bob, t);
        _swap(alice, key, !tokenIsToken0, 300e6);
        _swap(bob, key, !tokenIsToken0, 100e6);
        _swap(bob, key, tokenIsToken0, token.balanceOf(bob) / 4);
        uint256 aliceBal = token.balanceOf(alice);
        uint256 bobBal = token.balanceOf(bob);

        uint256 revenue = hook().pendingTax(PoolId.unwrap(key.toId()));
        hook().flush(key);
        uint256 creatorPool = revenue - (revenue * 1_000) / 10_000;
        uint256 holdersCut = (creatorPool * 2_000) / 10_000;
        assertEq(sp.recipientCredits()[2], holdersCut);

        assertEq(token.distribute(), holdersCut, "the holders' 20% was shared");
        uint256 supply = aliceBal + bobBal + token.balanceOf(s.housePad.lockerForToken(t));
        assertEq(token.eligibleSupply(), supply);
        assertApproxEqAbs(token.dividendsOf(alice), (holdersCut * aliceBal) / supply, 1);
        assertApproxEqAbs(token.dividendsOf(bob), (holdersCut * bobBal) / supply, 1);
        assertEq(token.dividendsOf(POOL_MANAGER), 0, "the pool never earns");

        uint256 u0 = IERC20(USDG).balanceOf(alice);
        vm.prank(alice);
        uint256 paid = token.claim();
        assertGt(paid, 0);
        assertEq(IERC20(USDG).balanceOf(alice), u0 + paid, "alice paid in real USDG");

        u0 = IERC20(USDG).balanceOf(team);
        sp.claimRecipient(1);
        assertEq(IERC20(USDG).balanceOf(team), u0 + (creatorPool * 2_000) / 10_000, "team wallet paid");
        uint256 t0 = IERC20(USDG).balanceOf(address(s.treasury));
        s.housePad.claimPlatformFees(0, 10);
        assertEq(IERC20(USDG).balanceOf(address(s.treasury)), t0 + (revenue * 1_000) / 10_000, "platform's 10% reached the treasury");
        uint256 bucket = sp.buybackCredit();
        vm.prank(creator);
        uint256 burned = sp.executeBuyback(bucket, 1);
        assertEq(token.balanceOf(DEAD), burned, "buyback burned");
        assertEq(token.eligibleSupply(), supply, "burned tokens never earn");

        // Plain launches still work on the same pad.
        vm.prank(creator);
        (address plain,) = s.housePad.createLaunch(
            PadPortal.CreateLaunchParams({
                name: "Fork Plain", symbol: "FPLAIN", startingMarketCapQuote: 1_000e6, buyTaxBps: 300, sellTaxBps: 300
            }),
            _solo(creator),
            0,
            0
        );
        assertEq(PadRevenueSplitter(s.housePad.splitterForToken(plain)).platformShareBps(), 1_000);
    }

    function hook() internal view returns (RobinHook) {
        return s.hook;
    }
}
