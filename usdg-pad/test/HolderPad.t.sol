// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "@uniswap/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobinHook} from "../src/RobinHook.sol";
import {RobinTreasury} from "../src/RobinTreasury.sol";
import {RobinPadFactory} from "../src/RobinPadFactory.sol";
import {PadPortal} from "../src/PadPortal.sol";
import {PadRevenueSplitter} from "../src/PadRevenueSplitter.sol";
import {RobinLaunchToken} from "../src/RobinLaunchToken.sol";
import {HolderPadPortal} from "../src/HolderPadPortal.sol";
import {HolderPadTemplate} from "../src/HolderPadTemplate.sol";
import {HolderTokenDeployer} from "../src/HolderTokenDeployer.sol";
import {RobinHolderToken} from "../src/RobinHolderToken.sol";

/// @notice Holder dividends: HolderPadTemplate through the factory's
/// template slot, HolderPadPortal launches and RobinHolderToken payouts,
/// on a local PoolManager with the real RobinHook.
contract HolderPadTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MockERC20 usdc;
    RobinHook hook;
    RobinTreasury treasury;
    RobinPadFactory factory;
    PadRevenueSplitter splitterImpl;
    HolderTokenDeployer tokenDeployer;
    HolderPadTemplate template;
    HolderPadPortal pad; // the holders house pad (Robin Labs takes 10%)

    address padOwner = makeAddr("padOwner");
    address creator = makeAddr("creator");
    address marketing = makeAddr("marketing");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 constant STARTING_MC = 5_000e6;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 ether;

    function setUp() public {
        deployFreshManagerAndRouters();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory args = abi.encode(address(manager), address(this));
        (address predicted, bytes32 salt) = HookMiner.find(address(this), flags, type(RobinHook).creationCode, args);
        hook = new RobinHook{salt: salt}(address(manager), address(this));
        require(address(hook) == predicted, "hook address mismatch");
        treasury = new RobinTreasury(makeAddr("treasuryOwner"));
        splitterImpl = new PadRevenueSplitter();
        factory = new RobinPadFactory(
            address(manager), address(hook), address(treasury), address(usdc), address(splitterImpl), 100e6, address(this)
        );
        hook.bootstrapFactory(address(factory));

        // What the owner's deploy does: deployer, template, approve, house pad.
        tokenDeployer = new HolderTokenDeployer();
        template = new HolderPadTemplate(
            address(factory), address(manager), address(hook), address(treasury), address(usdc), address(splitterImpl),
            address(tokenDeployer)
        );
        factory.setTemplateApproved(address(template), true);
        pad = HolderPadPortal(
            factory.deployHousePadFromTemplate(address(template), "Robin Labs Pad", padOwner, abi.encode(_settings()))
        );

        usdc.mint(creator, 100_000e6);
        usdc.mint(alice, 100_000e6);
        usdc.mint(bob, 100_000e6);
        usdc.mint(carol, 100_000e6);
    }

    // ---------------------------------------------------------------- helpers

    function _settings() internal pure returns (PadPortal.PadSettings memory) {
        return PadPortal.PadSettings({
            padOwnerShareBps: 0,
            minTaxBps: 0,
            maxTaxBps: 1_000,
            launchFee: 0,
            minStartingMarketCapQuote: 100e6,
            launchesPaused: false,
            inviteOnly: false,
            maxStartingMarketCapQuote: 10_000e6
        });
    }

    function _params(uint16 taxBps) internal pure returns (PadPortal.CreateLaunchParams memory) {
        return PadPortal.CreateLaunchParams({
            name: "Holder Robin Labs", symbol: "HROBIN", startingMarketCapQuote: STARTING_MC, buyTaxBps: taxBps, sellTaxBps: taxBps
        });
    }

    /// @dev Creator 50%, marketing 20%, buyback 10% (holders get the rest).
    function _alloc() internal view returns (PadPortal.FeeAllocation memory a) {
        a.recipients = new address[](2);
        a.recipients[0] = creator;
        a.recipients[1] = marketing;
        a.recipientBps = new uint16[](2);
        a.recipientBps[0] = 5_000;
        a.recipientBps[1] = 2_000;
        a.buybackBps = 1_000;
    }

    function _launch(PadPortal.FeeAllocation memory a, uint16 holdersBps, uint16 taxBps)
        internal
        returns (RobinHolderToken token, PadRevenueSplitter sp)
    {
        vm.prank(creator);
        (address t,) = pad.createLaunchWithHolders(_params(taxBps), a, holdersBps, 0, 0);
        token = RobinHolderToken(t);
        sp = PadRevenueSplitter(pad.splitterForToken(t));
    }

    /// @dev Rounding dust the locker keeps from seeding the pool (a few wei).
    function _dust(RobinHolderToken token) internal view returns (uint256) {
        return token.balanceOf(pad.lockerForToken(address(token)));
    }

    function _keyFor(address token) internal view returns (PoolKey memory) {
        bool t0 = token < address(usdc);
        return PoolKey({
            currency0: Currency.wrap(t0 ? token : address(usdc)),
            currency1: Currency.wrap(t0 ? address(usdc) : token),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
    }

    function _swap(address who, address token, bool buying, uint256 amountIn) internal returns (uint256 out) {
        PoolKey memory key = _keyFor(token);
        bool tokenIsToken0 = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = buying ? !tokenIsToken0 : tokenIsToken0;
        address outAsset = buying ? token : address(usdc);
        uint256 before = IERC20(outAsset).balanceOf(who);
        vm.startPrank(who);
        IERC20(buying ? address(usdc) : token).approve(address(swapRouter), amountIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        out = IERC20(outAsset).balanceOf(who) - before;
    }

    function _flush(address token) internal returns (uint256 revenue) {
        PoolKey memory key = _keyFor(token);
        revenue = hook.pendingTax(PoolId.unwrap(key.toId()));
        hook.flush(key);
    }

    /// @dev The holders' USDC out of `revenue` flushed into the splitter.
    function _holdersCut(uint256 revenue, uint16 holdersBps) internal pure returns (uint256) {
        uint256 creatorPool = revenue - (revenue * 1_000) / 10_000;
        return (creatorPool * holdersBps) / 10_000;
    }

    // -------------------------------------------------------------- the pad

    function test_TemplateBuildsAHousePadWiredLikeRobinPad() public view {
        assertTrue(factory.isPad(address(pad)));
        assertTrue(factory.isHousePad(address(pad)));
        assertEq(factory.templateOf(address(pad)), address(template));
        assertTrue(hook.isAuthorizedPortal(address(pad)), "the hook trusts the holders pad");
        assertEq(pad.platformShareBps(), 1_000, "Robin Labs takes 10% on a house pad");
        assertEq(pad.padOwner(), padOwner);
        assertEq(pad.factory(), address(template));
        assertEq(pad.holderTokenDeployer(), address(tokenDeployer));
        (,,,,,,, uint256 maxMc) = pad.settings();
        assertEq(maxMc, 10_000e6, "same $10k cap as Robin Labs Pad");
    }

    function test_OnlyTheFactoryCanUseTheTemplate() public {
        vm.expectRevert(HolderPadTemplate.NotFactory.selector);
        template.deployPortal(address(this), 0, abi.encode(_settings()));
    }

    function test_TemplateRejectsZeroAddresses() public {
        vm.expectRevert(HolderPadTemplate.ZeroAddress.selector);
        new HolderPadTemplate(
            address(factory), address(manager), address(hook), address(treasury), address(usdc), address(splitterImpl), address(0)
        );
    }

    function test_WhiteLabelHolderPadsTakeFifteenPercent() public {
        vm.startPrank(alice);
        usdc.approve(address(factory), 100e6);
        HolderPadPortal wl =
            HolderPadPortal(factory.deployPadFromTemplate(address(template), "Alice Pad", abi.encode(_settings()), 100e6));
        vm.stopPrank();
        assertEq(wl.platformShareBps(), 1_500);
        assertEq(wl.padOwner(), alice);
        assertTrue(hook.isAuthorizedPortal(address(wl)));
    }

    function test_PlainLaunchesStillWorkExactlyAsBefore() public {
        PadPortal.FeeAllocation memory a;
        a.recipients = new address[](1);
        a.recipients[0] = creator;
        a.recipientBps = new uint16[](1);
        a.recipientBps[0] = 10_000;
        vm.prank(creator);
        (address token,) = pad.createLaunch(_params(300), a, 0, 0);
        assertEq(pad.holdersBpsForToken(token), 0);
        assertEq(
            RobinLaunchToken(token).balanceOf(address(manager)) + RobinLaunchToken(token).balanceOf(pad.lockerForToken(token)),
            TOTAL_SUPPLY
        );
        // A plain RobinLaunchToken: no dividend functions.
        (bool ok,) = token.call(abi.encodeWithSignature("distribute()"));
        assertFalse(ok, "plain launches get the plain token");
        uint256 got = _swap(alice, token, true, 100e6);
        assertGt(got, 0);
    }

    function test_HolderLaunchAddsTheTokenAsTheLastPayoutWallet() public {
        (RobinHolderToken token, PadRevenueSplitter sp) = _launch(_alloc(), 2_000, 300);
        (address[] memory r, uint16[] memory bps, uint16 buyback) = sp.allocation();
        assertEq(r.length, 3);
        assertEq(r[0], creator);
        assertEq(r[1], marketing);
        assertEq(r[2], address(token), "holders' slot pays the token itself");
        assertEq(bps[2], 2_000);
        assertEq(buyback, 1_000);
        assertEq(token.holdersSlot(), 2);
        assertEq(token.splitter(), address(sp));
        assertEq(token.minter(), address(pad));
        assertEq(token.quoteAsset(), address(usdc));
        assertEq(token.poolManager(), address(manager));
        assertEq(pad.holdersBpsForToken(address(token)), 2_000);
        assertEq(pad.launchCount(), 1);
        assertEq(token.totalSupply(), TOTAL_SUPPLY);
        uint256 dust = _dust(token);
        assertLt(dust, 1e9, "the locker keeps only a few wei of rounding dust from seeding");
        assertEq(token.balanceOf(address(manager)) + dust, TOTAL_SUPPLY, "whole supply in the pool");
        assertEq(token.eligibleSupply(), dust, "nobody but the pool holds any yet");
    }

    function test_HoldersCanTakeEverythingButTheyNeedAShare() public {
        PadPortal.FeeAllocation memory none;
        none.recipients = new address[](0);
        none.recipientBps = new uint16[](0);
        (RobinHolderToken token, PadRevenueSplitter sp) = _launch(none, 10_000, 300);
        (address[] memory r,,) = sp.allocation();
        assertEq(r.length, 1);
        assertEq(r[0], address(token), "100% to holders is allowed");

        vm.prank(creator);
        vm.expectRevert(PadRevenueSplitter.InvalidAllocation.selector);
        pad.createLaunchWithHolders(_params(300), _alloc(), 0, 0, 0); // 0% to holders
    }

    function test_AllocationMustStillBeValid() public {
        // 5 wallets + holders = 6 payout wallets: too many.
        PadPortal.FeeAllocation memory five;
        five.recipients = new address[](5);
        five.recipientBps = new uint16[](5);
        for (uint256 i; i < 5; i++) {
            five.recipients[i] = address(uint160(0x1000 + i));
            five.recipientBps[i] = 1_000;
        }
        vm.startPrank(creator);
        vm.expectRevert(PadRevenueSplitter.InvalidAllocation.selector);
        pad.createLaunchWithHolders(_params(300), five, 5_000, 0, 0);
        // Doesn't add up to 100%.
        vm.expectRevert(PadRevenueSplitter.InvalidAllocation.selector);
        pad.createLaunchWithHolders(_params(300), _alloc(), 1_000, 0, 0);
        // Mismatched lists.
        PadPortal.FeeAllocation memory bad = _alloc();
        bad.recipientBps = new uint16[](1);
        bad.recipientBps[0] = 7_000;
        vm.expectRevert(PadRevenueSplitter.InvalidAllocation.selector);
        pad.createLaunchWithHolders(_params(300), bad, 2_000, 0, 0);
        // A zero wallet.
        PadPortal.FeeAllocation memory zero = _alloc();
        zero.recipients[1] = address(0);
        vm.expectRevert(PadRevenueSplitter.ZeroAddress.selector);
        pad.createLaunchWithHolders(_params(300), zero, 2_000, 0, 0);
        vm.stopPrank();

        // 4 wallets + holders = 5 is the most.
        PadPortal.FeeAllocation memory four;
        four.recipients = new address[](4);
        four.recipientBps = new uint16[](4);
        for (uint256 i; i < 4; i++) {
            four.recipients[i] = address(uint160(0x1000 + i));
            four.recipientBps[i] = 2_000;
        }
        (RobinHolderToken token,) = _launch(four, 2_000, 300);
        assertEq(token.holdersSlot(), 4);
    }

    function test_PadRulesApplyToHolderLaunchesToo() public {
        vm.startPrank(creator);
        vm.expectRevert(PadPortal.TaxTooHigh.selector);
        pad.createLaunchWithHolders(_params(1_100), _alloc(), 2_000, 0, 0);
        PadPortal.CreateLaunchParams memory big = _params(300);
        big.startingMarketCapQuote = 10_001e6;
        vm.expectRevert(PadPortal.StartingMcOutOfRange.selector);
        pad.createLaunchWithHolders(big, _alloc(), 2_000, 0, 0);
        vm.stopPrank();

        PadPortal.PadSettings memory s = _settings();
        s.launchesPaused = true;
        vm.prank(padOwner);
        pad.setSettings(s);
        vm.prank(creator);
        vm.expectRevert(PadPortal.LaunchesPaused.selector);
        pad.createLaunchWithHolders(_params(300), _alloc(), 2_000, 0, 0);

        s.launchesPaused = false;
        s.inviteOnly = true;
        s.minTaxBps = 200;
        s.padOwnerShareBps = 1_000;
        s.launchFee = 50e6;
        vm.prank(padOwner);
        pad.setSettings(s);
        vm.startPrank(creator);
        vm.expectRevert(PadPortal.NotApproved.selector);
        pad.createLaunchWithHolders(_params(300), _alloc(), 2_000, 1_000, 50e6);
        vm.stopPrank();
        address[] memory list = new address[](1);
        list[0] = creator;
        vm.prank(padOwner);
        pad.setApprovedCreators(list, true);
        vm.startPrank(creator);
        vm.expectRevert(PadPortal.TaxTooLow.selector);
        pad.createLaunchWithHolders(_params(100), _alloc(), 2_000, 1_000, 50e6);
        vm.expectRevert(PadPortal.TermsChanged.selector);
        pad.createLaunchWithHolders(_params(300), _alloc(), 2_000, 999, 50e6);
        vm.expectRevert(PadPortal.TermsChanged.selector);
        pad.createLaunchWithHolders(_params(300), _alloc(), 2_000, 1_000, 49e6);

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        uint256 ownerBefore = usdc.balanceOf(padOwner);
        usdc.approve(address(pad), 50e6);
        (address token,) = pad.createLaunchWithHolders(_params(300), _alloc(), 2_000, 1_000, 50e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + 5e6, "Robin Labs gets 10% of the launch fee");
        assertEq(usdc.balanceOf(padOwner), ownerBefore + 45e6);
        assertEq(PadRevenueSplitter(pad.splitterForToken(token)).padOwnerShareBps(), 1_000);
    }

    function test_PadsOwnTaxCapBelowTenPercentIsEnforced() public {
        PadPortal.PadSettings memory s = _settings();
        s.maxTaxBps = 500; // the hook would allow up to 10%; this pad allows 5%
        vm.prank(padOwner);
        pad.setSettings(s);
        vm.prank(creator);
        vm.expectRevert(PadPortal.TaxTooHigh.selector);
        pad.createLaunchWithHolders(_params(600), _alloc(), 2_000, 0, 0);
        _launch(_alloc(), 2_000, 500);
    }

    function test_EmitsTheSameLaunchEventPlusTheHolderShare() public {
        vm.recordLogs();
        (RobinHolderToken token,) = _launch(_alloc(), 2_000, 300);
        bytes32 launchSig = keccak256(
            "LaunchCreated(address,address,address,address,bytes32,address,bool,uint16,uint16,int24,int24,uint160,string,string)"
        );
        bytes32 holderSig = keccak256("HolderShare(address,uint256,uint16)");
        bool sawLaunch;
        bool sawHolder;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(pad)) continue;
            if (logs[i].topics[0] == launchSig && address(uint160(uint256(logs[i].topics[1]))) == address(token)) sawLaunch = true;
            if (logs[i].topics[0] == holderSig) {
                (uint256 slot, uint16 bps) = abi.decode(logs[i].data, (uint256, uint16));
                assertEq(slot, 2);
                assertEq(bps, 2_000);
                sawHolder = true;
            }
        }
        assertTrue(sawLaunch, "LaunchCreated, same signature every indexer reads");
        assertTrue(sawHolder);
    }

    // ------------------------------------------------------------ dividends

    function test_HoldersSplitTheirSharePerBalanceAndClaimUsdc() public {
        (RobinHolderToken token, PadRevenueSplitter sp) = _launch(_alloc(), 2_000, 500);
        uint256 a = _swap(alice, address(token), true, 300e6);
        uint256 b = _swap(bob, address(token), true, 100e6);
        uint256 revenue = _flush(address(token));
        uint256 holders = _holdersCut(revenue, 2_000);

        assertEq(token.pendingDistribution(), sp.recipientCredits()[2], "waiting in the splitter's holders slot");
        uint256 shared = token.distribute();
        assertEq(shared, holders, "the whole holders' slot was shared");
        assertEq(sp.recipientCredits()[2], 0);
        assertEq(token.eligibleSupply(), a + b + _dust(token));

        uint256 aliceDue = token.dividendsOf(alice);
        uint256 bobDue = token.dividendsOf(bob);
        assertApproxEqAbs(aliceDue, (holders * a) / (a + b), 1);
        assertApproxEqAbs(bobDue, (holders * b) / (a + b), 1);
        assertLe(aliceDue + bobDue, holders, "never pays out more than came in");
        assertEq(token.dividendsOf(address(manager)), 0, "the pool earns nothing");
        assertEq(token.dividendsOf(carol), 0);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        assertEq(token.claim(), aliceDue);
        assertEq(usdc.balanceOf(alice), before + aliceDue);
        assertEq(token.dividendsOf(alice), 0);
        vm.prank(alice);
        assertEq(token.claim(), 0, "nothing twice");

        // The rest of the split is unchanged: creator, marketing, buyback.
        uint256 creatorPool = revenue - (revenue * 1_000) / 10_000;
        assertEq(sp.buybackCredit(), (creatorPool * 1_000) / 10_000);
        assertEq(sp.creditOf(marketing), (creatorPool * 2_000) / 10_000);
        assertEq(sp.platformCredit(), (revenue * 1_000) / 10_000, "Robin Labs' 10% off the top");
    }

    function test_ClaimSharesOutNewMoneyFirst() public {
        (RobinHolderToken token,) = _launch(_alloc(), 2_000, 500);
        uint256 a = _swap(alice, address(token), true, 200e6);
        uint256 revenue = _flush(address(token));
        // No distribute() call: claim does it.
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = token.claim();
        assertGt(a, 0);
        assertApproxEqAbs(paid, _holdersCut(revenue, 2_000), 1, "sole holder gets the whole holders' share");
        assertEq(usdc.balanceOf(alice), before + paid);
    }

    function test_EarningsStayAfterSellingAndNewBuyersDontGetOldMoney() public {
        (RobinHolderToken token,) = _launch(_alloc(), 2_000, 500);
        uint256 a = _swap(alice, address(token), true, 300e6);
        uint256 revenue1 = _flush(address(token));
        token.distribute();
        uint256 aliceEarned = token.dividendsOf(alice);
        assertApproxEqAbs(aliceEarned, _holdersCut(revenue1, 2_000), 1);

        // Alice sells everything; Bob buys after the payout.
        _swap(alice, address(token), false, a);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.dividendsOf(alice), aliceEarned, "selling never loses what you earned");
        uint256 b = _swap(bob, address(token), true, 100e6);
        assertEq(token.dividendsOf(bob), 0, "no share of money shared before you bought");

        uint256 revenue2 = _flush(address(token));
        token.distribute();
        assertEq(token.dividendsOf(alice), aliceEarned, "no new money for a wallet that holds nothing");
        assertApproxEqAbs(token.dividendsOf(bob), _holdersCut(revenue2, 2_000), 1);
        assertEq(token.eligibleSupply(), b + _dust(token));
    }

    function test_TransfersMoveTokensButNotPastEarnings() public {
        (RobinHolderToken token,) = _launch(_alloc(), 2_000, 500);
        uint256 a = _swap(alice, address(token), true, 300e6);
        uint256 revenue = _flush(address(token));
        token.distribute();
        uint256 earned = token.dividendsOf(alice);

        vm.prank(alice);
        token.transfer(bob, a / 2);
        assertEq(token.dividendsOf(alice), earned);
        assertEq(token.dividendsOf(bob), 0);
        assertEq(token.eligibleSupply(), a + _dust(token));

        // New money splits 50/50 now.
        usdc.mint(address(token), 1_000e6); // anyone can top up holders directly
        token.distribute();
        assertApproxEqAbs(token.dividendsOf(alice) - earned, 500e6, 1);
        assertApproxEqAbs(token.dividendsOf(bob), 500e6, 1);
        assertGt(revenue, 0);

        // Burning (sending to the dead address) drops out of the payouts.
        vm.prank(bob);
        token.transfer(DEAD, a / 2);
        assertEq(token.eligibleSupply(), a - a / 2 + _dust(token));
        assertEq(token.dividendsOf(DEAD), 0);
    }

    function test_NoTradingRestrictions() public {
        (RobinHolderToken token,) = _launch(_alloc(), 2_000, 0);
        // Tiny and huge trades, wallet to wallet, back and forth.
        uint256 got = _swap(alice, address(token), true, 1);
        got += _swap(alice, address(token), true, 50_000e6);
        assertGt(got, 0);
        vm.startPrank(alice);
        token.transfer(bob, got);
        vm.stopPrank();
        vm.prank(bob);
        token.transfer(bob, got); // to yourself
        vm.prank(bob);
        token.approve(carol, got);
        vm.prank(carol);
        token.transferFrom(bob, carol, got);
        _swap(carol, address(token), false, got);
        assertEq(token.balanceOf(carol), 0);
        assertEq(token.eligibleSupply(), _dust(token));
    }

    function test_WaitsWhileTooFewTokensAreOutsideThePool() public {
        (RobinHolderToken token,) = _launch(_alloc(), 2_000, 500);
        uint256 tiny = _swap(alice, address(token), true, 1e6); // ~200k tokens at $5k MC: under 1M
        assertLt(tiny, token.MIN_ELIGIBLE_SUPPLY());
        uint256 revenue = _flush(address(token));
        uint256 due = _holdersCut(revenue, 2_000);
        assertEq(token.distribute(), 0, "waits");
        assertEq(usdc.balanceOf(address(token)), due, "the USDC is pulled and kept for later");
        assertEq(token.dividendsOf(alice), 0);

        uint256 b = _swap(bob, address(token), true, 100e6);
        uint256 revenue2 = _flush(address(token));
        uint256 shared = token.distribute();
        uint256 all = due + _holdersCut(revenue2, 2_000);
        assertEq(shared, all, "everything that waited is shared once there are holders");
        assertApproxEqAbs(token.dividendsOf(bob), (all * b) / (b + tiny), 1);
        assertApproxEqAbs(token.dividendsOf(alice), (all * tiny) / (b + tiny), 1);
    }

    function test_NobodyCanMoveTheHoldersSlot() public {
        (RobinHolderToken token, PadRevenueSplitter sp) = _launch(_alloc(), 2_000, 500);
        vm.prank(creator);
        vm.expectRevert(PadRevenueSplitter.NotAuthorized.selector);
        sp.updateRecipient(2, creator);
        vm.prank(padOwner);
        vm.expectRevert(PadRevenueSplitter.NotAuthorized.selector);
        sp.updateRecipient(2, padOwner);
        (address[] memory r,,) = sp.allocation();
        assertEq(r[2], address(token));
        // And the token can't be re-pointed: it has no admin or setter at all.
        (bool ok,) = address(token).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
    }

    function test_AnyoneCanPayTheHoldersSlotIntoTheToken() public {
        (RobinHolderToken token, PadRevenueSplitter sp) = _launch(_alloc(), 2_000, 500);
        _swap(alice, address(token), true, 300e6);
        uint256 revenue = _flush(address(token));
        vm.prank(carol);
        sp.distribute(); // "Pay all wallets" pays the token its slot too
        assertEq(usdc.balanceOf(address(token)), _holdersCut(revenue, 2_000));
        assertEq(token.pendingDistribution(), _holdersCut(revenue, 2_000));
        token.distribute();
        assertEq(token.pendingDistribution(), 0);
        assertApproxEqAbs(token.dividendsOf(alice), _holdersCut(revenue, 2_000), 1);
    }

    function test_BuybackAndBurnWorksWithHolders() public {
        (RobinHolderToken token, PadRevenueSplitter sp) = _launch(_alloc(), 2_000, 500);
        uint256 a = _swap(alice, address(token), true, 500e6);
        _flush(address(token));
        uint256 bucket = sp.buybackCredit();
        assertGt(bucket, 0);
        vm.prank(creator);
        uint256 burned = sp.executeBuyback(bucket, 1);
        assertGt(burned, 0);
        assertEq(token.balanceOf(DEAD), burned);
        assertEq(token.eligibleSupply(), a + _dust(token), "burned tokens never earn");
    }

    function test_CreatorsOwnWalletsGetPaidAsUsual() public {
        (RobinHolderToken token, PadRevenueSplitter sp) = _launch(_alloc(), 2_000, 500);
        _swap(alice, address(token), true, 300e6);
        uint256 revenue = _flush(address(token));
        uint256 creatorPool = revenue - (revenue * 1_000) / 10_000;
        uint256 before = usdc.balanceOf(marketing);
        sp.claimRecipient(1);
        assertEq(usdc.balanceOf(marketing), before + (creatorPool * 2_000) / 10_000);
        vm.prank(creator);
        sp.claim(creator, address(usdc));
        assertEq(sp.creditOf(creator), 0);
    }

    function test_ManyRoundsNeverOverpay() public {
        (RobinHolderToken token,) = _launch(_alloc(), 2_000, 1_000);
        address[3] memory who = [alice, bob, carol];
        for (uint256 round; round < 12; round++) {
            address w = who[round % 3];
            uint256 got = _swap(w, address(token), true, (round + 1) * 37e6);
            if (round % 4 == 3) _swap(w, address(token), false, got / 3);
            if (round % 5 == 4) {
                vm.prank(w);
                token.transfer(who[(round + 1) % 3], got / 5);
            }
            _flush(address(token));
            token.distribute();
            if (round % 3 == 2) {
                vm.prank(who[round % 2]);
                token.claim();
            }
        }
        uint256 owed = token.dividendsOf(alice) + token.dividendsOf(bob) + token.dividendsOf(carol);
        assertLe(owed, usdc.balanceOf(address(token)), "the token always holds enough for every claim");
        assertEq(token.totalDistributed() - token.totalClaimed(), usdc.balanceOf(address(token)));
        uint256 sum = token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(carol);
        assertEq(token.eligibleSupply(), sum + _dust(token));
        for (uint256 i; i < 3; i++) {
            vm.prank(who[i]);
            token.claim();
        }
        assertLe(usdc.balanceOf(address(token)), 3, "only rounding dust is left");
    }
}
