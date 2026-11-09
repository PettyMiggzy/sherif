// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-periphery/lib/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OneShotNativeSwap} from "./helpers/OneShotNativeSwap.sol";

/// Probe on a fork of Elysium mainnet (ELYSIUM_FORK_URL): how much USDC does 0.03 HYPE buy in the
/// native-HYPE/USDC pool (1% fee, no hook) on each Uniswap v4 manager that holds it?
contract OneShotSwapForkTest is Test {
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    receive() external payable {}

    function test_probe() public {
        string memory url = vm.envOr("ELYSIUM_FORK_URL", string(""));
        if (bytes(url).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(url);
        assertEq(block.chainid, 99901);
        PoolKey memory key = PoolKey({currency0: Currency.wrap(address(0)), currency1: Currency.wrap(USDC), fee: 10_000, tickSpacing: 200, hooks: IHooks(address(0))});
        address[2] memory managers = [0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1, 0x5fb015a49f5b35073f9Ce01C2aDb287A75F89600];
        vm.deal(address(this), 1 ether);
        for (uint256 i; i < 2; i++) {
            OneShotNativeSwap h = new OneShotNativeSwap(IPoolManager(managers[i]));
            uint256 before = IERC20(USDC).balanceOf(address(this));
            uint256 hype0 = address(this).balance;
            try h.swap{value: 0.03 ether}(key, 1, address(this)) returns (uint256 out) {
                console2.log("manager", managers[i]);
                console2.log("  USDC out (6 dec):", out);
                console2.log("  USDC balance delta:", IERC20(USDC).balanceOf(address(this)) - before);
                console2.log("  HYPE spent (wei):", hype0 - address(this).balance);
                console2.log("  helper left holding HYPE:", address(h).balance);
            } catch Error(string memory why) {
                console2.log("manager", managers[i], "swap reverted:", why);
            } catch {
                console2.log("manager", managers[i], "swap reverted (no reason)");
            }
        }
    }
}
