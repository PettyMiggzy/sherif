// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {RobinPortal} from "../src/RobinPortal.sol";
import {RobinLocker} from "../src/RobinLocker.sol";
import {RobinRevenueSplitter} from "../src/RobinRevenueSplitter.sol";
import {PadRouter} from "../src/PadRouter.sol";
import {ElysiumStack} from "../script/ElysiumStack.sol";

/// @notice The whole pad on REAL Kinetiq Elysium state (testnet 99801 by default; mainnet 99901 with ELYSIUM_CHAIN_ID/ELYSIUM_USDC):
/// the deploy routine the script runs (ElysiumStack), the chain's bridged
/// USDC and canonical Permit2, swaps through PadRouter encoded exactly as the
/// site encodes them. Skipped unless ELYSIUM_FORK_URL is set:
///   ELYSIUM_FORK_URL=https://testnet-rpc.elysium.kinetiq.xyz forge test --match-contract ForkElysiumTest -vv
contract ForkElysiumTest is Test, ElysiumStack {
    using PoolIdLibrary for PoolKey;

    // Bridged USDC. Defaults to the testnet one; for another chain set ELYSIUM_CHAIN_ID and ELYSIUM_USDC.
    address USDC;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct ExactInSingle {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    ElysiumDeploy d;
    PadRouter router;

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("ELYSIUM_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url);
        assertEq(block.chainid, vm.envOr("ELYSIUM_CHAIN_ID", uint256(99801)), "forked the wrong Elysium chain");
        USDC = vm.envOr("ELYSIUM_USDC", address(0x7D29d8047B905000459c0E80c34a26CeedcB47b2));
        d = _deployElysium(address(this), address(this), address(this), USDC, address(0), PERMIT2, 100e6, "Elysium Pad", address(0));
        router = PadRouter(d.router);
        return true;
    }

    function _key(address token) internal view returns (PoolKey memory k, bool tokenIsToken0) {
        tokenIsToken0 = token < USDC;
        k = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : USDC),
            currency1: Currency.wrap(tokenIsToken0 ? USDC : token),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(d.stack.hook))
        });
    }

    function _swap(address who, address token, bool isBuy, uint128 amountIn) internal {
        (PoolKey memory k, bool t0) = _key(token);
        bool zeroForOne = isBuy ? !t0 : t0;
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInSingle(k, zeroForOne, amountIn, 1, 0, ""));
        params[1] = abi.encode(isBuy ? USDC : token, uint256(amountIn));
        params[2] = abi.encode(isBuy ? token : USDC, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), params);
        vm.prank(who);
        router.execute(hex"10", inputs, block.timestamp + 60);
    }

    function _approve(address who, address token) internal {
        vm.startPrank(who);
        IERC20(USDC).approve(PERMIT2, type(uint256).max);
        IERC20(token).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(USDC, address(router), type(uint160).max, uint48(block.timestamp + 1 days));
        IAllowanceTransfer(PERMIT2).approve(token, address(router), type(uint160).max, uint48(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function test_LaunchTradeAndFeesOnRealElysiumState() public {
        if (!_fork()) return;
        assertEq(d.stack.mainPortal.quoteAsset(), USDC, "pools pair with the bridged USDC");

        // A $1M launch: the most the site offers. Liquidity = market cap.
        address creator = makeAddr("creator");
        vm.prank(creator);
        (address token, address locker) = d.stack.mainPortal.createLaunch(
            RobinPortal.CreateLaunchParams({
                name: "Elysium Fork", symbol: "ELYF", startingMarketCapQuote: 1_000_000e6, buyTaxBps: 300, sellTaxBps: 300
            })
        );
        assertEq(IERC20(token).totalSupply(), 1_000_000_000 ether);

        address trader = makeAddr("trader");
        deal(USDC, trader, 1_000e6);
        assertEq(IERC20(USDC).balanceOf(trader), 1_000e6, "deal() could not fund bridged USDC");
        _approve(trader, token);

        (PoolKey memory k,) = _key(token);
        bytes32 id = PoolId.unwrap(k.toId());
        _swap(trader, token, true, 100e6); // buy $100
        uint256 bought = IERC20(token).balanceOf(trader);
        assertGt(bought, 0, "bought nothing");
        assertEq(IERC20(USDC).balanceOf(trader), 900e6, "paid exactly $100");
        assertEq(d.stack.hook.pendingTax(id), 3e6, "3% buy tax in USDC");

        _swap(trader, token, false, uint128(bought / 2)); // sell half
        assertGt(IERC20(USDC).balanceOf(trader), 900e6, "the sell paid USDC");
        assertEq(IERC20(USDC).balanceOf(address(router)) + IERC20(token).balanceOf(address(router)), 0, "router ends empty");

        // Tax: 80% creator / 20% platform.
        uint256 pending = d.stack.hook.pendingTax(id);
        d.stack.hook.flush(k);
        RobinRevenueSplitter sp = RobinRevenueSplitter(RobinLocker(locker).splitter());
        assertEq(sp.creditedToCreator(USDC), pending - (pending * 2_000) / 10_000, "creator gets 80% of the tax");

        // LP fees: USDC side to the treasury, token side to the fee desk.
        uint256 t0 = IERC20(USDC).balanceOf(address(d.stack.treasury));
        RobinLocker(locker).harvestFees();
        assertGt(IERC20(USDC).balanceOf(address(d.stack.treasury)), t0, "USDC LP fees to the treasury");
        uint256 stock = d.stack.feeDesk.inventory(token);
        assertApproxEqRel(stock, (bought / 2) / 100, 0.001e18, "1% of the sell, in the token, at the desk");

        // The desk sells it at 10% under the pool, paid to the treasury.
        address deskBuyer = makeAddr("deskBuyer");
        (, uint256 cost) = d.stack.feeDesk.quoteAll(token);
        deal(USDC, deskBuyer, cost);
        vm.roll(block.number + 1);
        vm.startPrank(deskBuyer);
        IERC20(USDC).approve(address(d.stack.feeDesk), cost);
        (uint256 got, uint256 paid) = d.stack.feeDesk.buy(token, cost, 1, deskBuyer);
        vm.stopPrank();
        assertEq(got, stock, "bought the whole desk");
        assertLe(paid, cost);
        assertEq(d.stack.feeDesk.inventory(token), 0);

        // Admin can take the platform's money out.
        sp.claimPlatform(USDC);
        uint256 bal = IERC20(USDC).balanceOf(address(d.stack.treasury));
        address to = makeAddr("ops");
        d.stack.treasury.withdraw(USDC, to, bal);
        assertEq(IERC20(USDC).balanceOf(to), bal);
    }

    function test_DeployWiringOnRealElysiumState() public {
        if (!_fork()) return;
        assertEq(address(router.poolManager()), d.poolManager);
        assertEq(address(router.permit2()), PERMIT2);
        assertTrue(d.stack.hook.isAuthorizedPortal(address(d.stack.mainPortal)));
        assertEq(d.stack.mainPortal.feeDesk(), address(d.stack.feeDesk));
        assertEq(d.stack.housePad.platformShareBps(), 2_000);
    }
}
