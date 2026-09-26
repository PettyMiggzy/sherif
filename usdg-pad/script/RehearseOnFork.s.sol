// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TrollHook} from "../src/TrollHook.sol";
import {PadPortal} from "../src/PadPortal.sol";
import {HolderPadPortal} from "../src/HolderPadPortal.sol";
import {PadRevenueSplitter} from "../src/PadRevenueSplitter.sol";
import {TrollHolderToken} from "../src/TrollHolderToken.sol";

/// @notice Post-deploy rehearsal against a LOCAL fork, never mainnet: after
/// DeployRobinhood.s.sol has run on an anvil fork of Robinhood Chain, this
/// launches a holder-dividends coin on the deployed house pad and walks it
/// through buy, sell, flush, dividend claim and payouts with real USDG, as
/// real transactions from separate wallets.
///
///   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546
///   R=http://127.0.0.1:8546; TRADER=$(cast wallet address $TRADER_KEY)   # derive, don't retype
///   # fund the trader with 1,000 USDG (balances mapping is slot 1) and some ETH for gas:
///   cast rpc anvil_setStorageAt 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
///     $(cast index address $TRADER 1) $(cast to-uint256 1000000000) --rpc-url $R
///   cast rpc anvil_setBalance $TRADER 0x56BC75E2D63100000 --rpc-url $R
///   FORK_REHEARSAL=true HOUSE_PAD=<house pad> CREATOR_KEY=<key> TRADER_KEY=<key> \
///     forge script script/RehearseOnFork.s.sol --rpc-url $R --broadcast --legacy --slow
contract RehearseOnFork is Script {
    using PoolIdLibrary for PoolKey;

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external {
        require(vm.envOr("FORK_REHEARSAL", false), "local-fork rehearsal only: set FORK_REHEARSAL=true");
        HolderPadPortal pad = HolderPadPortal(vm.envAddress("HOUSE_PAD"));
        uint256 creatorKey = vm.envUint("CREATOR_KEY");
        uint256 traderKey = vm.envUint("TRADER_KEY");
        address creator = vm.addr(creatorKey);
        address trader = vm.addr(traderKey);
        TrollHook hook = TrollHook(pad.hook());
        require(IERC20(USDG).balanceOf(trader) >= 200e6, "fund the trader with USDG first (see header)");

        // 1. Launch: creator 80%, holders 20%, 3%/3% tax, $1,000 opening market cap.
        PadPortal.FeeAllocation memory a;
        a.recipients = new address[](1);
        a.recipients[0] = creator;
        a.recipientBps = new uint16[](1);
        a.recipientBps[0] = 8_000;
        vm.startBroadcast(creatorKey);
        (address t,) = pad.createLaunchWithHolders(
            PadPortal.CreateLaunchParams({
                name: "Rehearsal", symbol: "RHRS", startingMarketCapQuote: 1_000e6, buyTaxBps: 300, sellTaxBps: 300
            }),
            a,
            2_000,
            0,
            0
        );
        vm.stopBroadcast();
        console2.log("launched token:", t);

        bool tokenIsToken0 = t < USDG;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? t : USDG),
            currency1: Currency.wrap(tokenIsToken0 ? USDG : t),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
        bytes32 id = PoolId.unwrap(key.toId());

        // 2. Buy $100, then sell half, through the real PoolManager.
        vm.startBroadcast(traderKey);
        PoolSwapTest router = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        IERC20(USDG).approve(address(router), type(uint256).max);
        IERC20(t).approve(address(router), type(uint256).max);
        uint256 usdgBefore = IERC20(USDG).balanceOf(trader);
        _swap(router, key, !tokenIsToken0, 100e6);
        vm.stopBroadcast();
        uint256 bought = IERC20(t).balanceOf(trader);
        require(bought > 0, "buy returned no tokens");
        require(usdgBefore - IERC20(USDG).balanceOf(trader) == 100e6, "buy did not spend exactly $100");
        require(hook.pendingTax(id) == 3e6, "buy tax is not exactly 3% in USDG");
        console2.log("bought tokens:", bought);

        vm.startBroadcast(traderKey);
        _swap(router, key, tokenIsToken0, bought / 2);
        vm.stopBroadcast();
        uint256 revenue = hook.pendingTax(id);
        require(revenue > 3e6, "sell added no tax");
        console2.log("tax collected (raw USDG):", revenue);

        // 3. Flush, share with holders, pay everyone.
        PadRevenueSplitter sp = PadRevenueSplitter(pad.splitterForToken(t));
        vm.startBroadcast(traderKey);
        hook.flush(key);
        uint256 shared = TrollHolderToken(t).distribute();
        uint256 dividend = TrollHolderToken(t).claim();
        vm.stopBroadcast();
        uint256 creatorPool = revenue - (revenue * 1_000) / 10_000;
        require(shared == (creatorPool * 2_000) / 10_000, "holders did not get their 20%");
        require(dividend > 0, "trader earned no dividend");
        console2.log("holders shared (raw USDG):", shared);
        console2.log("trader dividend claimed (raw USDG):", dividend);

        uint256 creatorBefore = IERC20(USDG).balanceOf(creator);
        vm.startBroadcast(creatorKey);
        sp.claim(creator, USDG);
        vm.stopBroadcast();
        require(IERC20(USDG).balanceOf(creator) - creatorBefore == creatorPool - shared, "creator not paid 80%");

        address treasury = pad.treasury();
        uint256 tBefore = IERC20(USDG).balanceOf(treasury);
        vm.startBroadcast(traderKey);
        pad.claimPlatformFees(0, pad.launchCount());
        vm.stopBroadcast();
        require(IERC20(USDG).balanceOf(treasury) - tBefore == (revenue * 1_000) / 10_000, "platform 10% not paid");

        console2.log("REHEARSAL PASSED: launch, buy, sell, flush, dividends and payouts all in USDG");
    }

    function _swap(PoolSwapTest router, PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
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
}
