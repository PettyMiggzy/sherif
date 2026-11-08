// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "@uniswap/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IPoolManager as IRouterPoolManager} from "v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";

import {RobinPortal} from "../src/RobinPortal.sol";
import {RobinHook} from "../src/RobinHook.sol";
import {RobinTreasury} from "../src/RobinTreasury.sol";
import {RobinFeeDesk} from "../src/RobinFeeDesk.sol";
import {PadRouter} from "../src/PadRouter.sol";

contract RouterUSDC is MockERC20 {
    constructor() MockERC20("USD Coin", "USDC", 6) {}
}

/// @notice PadRouter: the UniversalRouter-compatible swap router for chains
/// without Uniswap's (Elysium). Swaps are encoded exactly as the site encodes
/// them (robin-pad-web/lib/swap.ts), in both pool orientations.
contract PadRouterTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant LOW_QUOTE = address(0x0000000000000000000000000000000000001000);
    address constant HIGH_QUOTE = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);
    uint16 constant TAX_BPS = 300;

    // The site's v4 action ids (v4-periphery Actions.sol).
    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant SETTLE_ALL = 0x0c;
    uint8 constant TAKE_ALL = 0x0f;

    /// Same ABI layout as IV4Router.ExactInputSingleParams (six fields).
    struct ExactInSingle {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    MockERC20 usdc;
    RobinHook hook;
    RobinPortal portal;
    PadRouter router;
    address token;
    PoolKey launchKey; // Deployers already has a `key`
    bool tokenIsToken0;

    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address attacker = makeAddr("attacker");

    function _setUp(address quoteAt) internal {
        deployFreshManagerAndRouters();
        new DeployPermit2().deployPermit2();
        deployCodeTo("PadRouter.t.sol:RouterUSDC", quoteAt);
        usdc = MockERC20(quoteAt);

        bytes memory args = abi.encode(address(manager), address(this));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(RobinHook).creationCode, args);
        hook = new RobinHook{salt: salt}(address(manager), address(this));
        RobinTreasury treasury = new RobinTreasury(makeAddr("treasuryOwner"));
        RobinFeeDesk desk = new RobinFeeDesk(address(manager), address(hook), quoteAt, address(treasury));
        portal = new RobinPortal(address(manager), address(hook), address(treasury), quoteAt, true, address(desk));
        hook.bootstrapMainPortal(address(portal));

        router = new PadRouter(IRouterPoolManager(address(manager)), IAllowanceTransfer(PERMIT2));

        vm.prank(creator);
        (token,) = portal.createLaunch(
            RobinPortal.CreateLaunchParams({
                name: "Router Test", symbol: "RTR", startingMarketCapQuote: 25_000e6, buyTaxBps: TAX_BPS, sellTaxBps: TAX_BPS
            })
        );
        tokenIsToken0 = token < quoteAt;
        launchKey = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : quoteAt),
            currency1: Currency.wrap(tokenIsToken0 ? quoteAt : token),
            fee: portal.POOL_FEE(),
            tickSpacing: portal.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });

        usdc.mint(trader, 10_000e6);
        _approveViaPermit2(trader);
    }

    /// What the site does before a trade: ERC-20 -> Permit2, Permit2 -> router.
    function _approveViaPermit2(address who) internal {
        vm.startPrank(who);
        usdc.approve(PERMIT2, type(uint256).max);
        MockERC20(token).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(address(usdc), address(router), type(uint160).max, uint48(block.timestamp + 1 days));
        IAllowanceTransfer(PERMIT2).approve(token, address(router), type(uint160).max, uint48(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function _swapParams(bool isBuy, uint128 amountIn, uint256 minOut) internal view returns (bytes memory) {
        bool zeroForOne = isBuy ? !tokenIsToken0 : tokenIsToken0;
        return abi.encode(ExactInSingle(launchKey, zeroForOne, amountIn, uint128(minOut), 0, ""));
    }

    /// The site's buildExactInSwap: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL.
    function _swapInput(bool isBuy, uint128 amountIn, uint256 minOut) internal view returns (bytes memory) {
        address currencyIn = isBuy ? address(usdc) : token;
        address currencyOut = isBuy ? token : address(usdc);
        bytes[] memory params = new bytes[](3);
        params[0] = _swapParams(isBuy, amountIn, minOut);
        params[1] = abi.encode(currencyIn, uint256(amountIn));
        params[2] = abi.encode(currencyOut, minOut);
        return abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
    }

    function _execute(address who, bytes memory commands, bytes memory input, uint256 deadline) internal {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = input;
        vm.prank(who);
        router.execute(commands, inputs, deadline);
    }

    /// The site's quoteExactIn: SWAP then TAKE_ALL(min = max), which reverts
    /// V4TooLittleReceived(min, actual) before anything is settled.
    function _quote(bool isBuy, uint128 amountIn) internal returns (uint256 out) {
        address currencyOut = isBuy ? token : address(usdc);
        bytes[] memory params = new bytes[](2);
        params[0] = _swapParams(isBuy, amountIn, 0);
        params[1] = abi.encode(currencyOut, type(uint256).max);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, TAKE_ALL), params);
        (bool ok, bytes memory ret) =
            address(router).call(abi.encodeCall(PadRouter.execute, (hex"10", inputs, block.timestamp + 60)));
        assertFalse(ok, "a quote must revert");
        assertEq(bytes4(ret), bytes4(keccak256("V4TooLittleReceived(uint256,uint256)")), "quote reverts with V4TooLittleReceived");
        (, out) = abi.decode(_tail(ret), (uint256, uint256));
    }

    function _tail(bytes memory b) internal pure returns (bytes memory t) {
        t = new bytes(b.length - 4);
        for (uint256 i; i < t.length; i++) t[i] = b[i + 4];
    }

    function _buySellRoundTrip(address quoteAt) internal {
        _setUp(quoteAt);
        uint256 usdcBefore = usdc.balanceOf(trader);

        uint256 quoted = _quote(true, 100e6);
        assertGt(quoted, 0, "quote returned nothing");
        _execute(trader, hex"10", _swapInput(true, 100e6, (quoted * 99) / 100), block.timestamp + 60);
        uint256 bought = MockERC20(token).balanceOf(trader);
        assertEq(bought, quoted, "the buy delivered exactly the quote");
        assertEq(usdcBefore - usdc.balanceOf(trader), 100e6, "spent exactly $100");
        assertEq(hook.pendingTax(PoolId.unwrap(launchKey.toId())), 3e6, "3% buy tax, in USDC, in the hook");

        uint256 quotedSell = _quote(false, uint128(bought / 2));
        _execute(trader, hex"10", _swapInput(false, uint128(bought / 2), (quotedSell * 99) / 100), block.timestamp + 60);
        assertEq(MockERC20(token).balanceOf(trader), bought - bought / 2, "sold half");
        assertEq(usdc.balanceOf(trader), usdcBefore - 100e6 + quotedSell, "sell paid exactly the quote");

        assertEq(usdc.balanceOf(address(router)), 0, "router keeps no USDC");
        assertEq(MockERC20(token).balanceOf(address(router)), 0, "router keeps no tokens");
    }

    function test_BuyAndSell_TokenIsCurrency1() public {
        _buySellRoundTrip(LOW_QUOTE);
    }

    function test_BuyAndSell_TokenIsCurrency0() public {
        _buySellRoundTrip(HIGH_QUOTE);
    }

    function test_OnlyTheCallerEverPays() public {
        _setUp(LOW_QUOTE);
        uint256 traderBefore = usdc.balanceOf(trader);
        // trader has approved the router; attacker sends the same swap. The
        // router can only pull from whoever called it, so it fails and the
        // trader's allowance is never touched.
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _swapInput(true, 100e6, 1);
        vm.prank(attacker);
        vm.expectRevert();
        router.execute(hex"10", inputs, block.timestamp + 60);
        assertEq(usdc.balanceOf(trader), traderBefore, "trader untouched");
        (uint160 left,,) = IAllowanceTransfer(PERMIT2).allowance(trader, address(usdc), address(router));
        assertEq(left, type(uint160).max, "trader's Permit2 allowance untouched");
    }

    function test_DeadlineAndCommandChecks() public {
        _setUp(LOW_QUOTE);
        bytes memory input = _swapInput(true, 10e6, 1);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = input;
        vm.startPrank(trader);
        vm.expectRevert(PadRouter.TransactionDeadlinePassed.selector);
        router.execute(hex"10", inputs, block.timestamp - 1);

        vm.expectRevert(abi.encodeWithSelector(PadRouter.InvalidCommandType.selector, 0x00));
        router.execute(hex"00", inputs, block.timestamp + 60);
        // UniversalRouter's "allow revert" flag on a V4 swap isn't supported either.
        vm.expectRevert(abi.encodeWithSelector(PadRouter.InvalidCommandType.selector, 0x10));
        router.execute(hex"90", inputs, block.timestamp + 60);

        vm.expectRevert(PadRouter.LengthMismatch.selector);
        router.execute(hex"1010", inputs, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_RefusesNativeCurrency() public {
        _setUp(LOW_QUOTE);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _swapInput(true, 10e6, 1);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        (bool ok,) = address(router).call{value: 1}(abi.encodeCall(PadRouter.execute, (hex"10", inputs, block.timestamp + 60)));
        assertFalse(ok, "execute is not payable");
    }

    function test_ExpiredPermit2AllowanceStopsTheSwap() public {
        _setUp(LOW_QUOTE);
        vm.warp(block.timestamp + 1 days + 1);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _swapInput(true, 10e6, 1);
        vm.prank(trader);
        vm.expectRevert();
        router.execute(hex"10", inputs, block.timestamp + 60);
    }

    function test_NoFreeLunchFromAnEmptyPool() public {
        _setUp(LOW_QUOTE);
        // Selling before anyone bought: the hook refuses a swap that fills
        // nothing, so the quote reverts with the hook's error, not a number.
        uint128 amount = 1e18;
        deal(token, trader, amount);
        address currencyOut = address(usdc);
        bytes[] memory params = new bytes[](2);
        params[0] = _swapParams(false, amount, 0);
        params[1] = abi.encode(currencyOut, type(uint256).max);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, TAKE_ALL), params);
        (bool ok, bytes memory ret) =
            address(router).call(abi.encodeCall(PadRouter.execute, (hex"10", inputs, block.timestamp + 60)));
        assertFalse(ok);
        assertTrue(bytes4(ret) != bytes4(keccak256("V4TooLittleReceived(uint256,uint256)")), "no fake quote from an empty pool");
    }
}
