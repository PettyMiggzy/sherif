// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-periphery/lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-periphery/lib/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-periphery/lib/v4-core/src/types/Currency.sol";
import {TickMath} from "v4-periphery/lib/v4-core/src/libraries/TickMath.sol";

/// @notice A one-off helper: swaps the native coin sent with the call for the pool's other currency
/// (native must be currency0) in a single Uniswap v4 pool, and sends the output to `to`. Holds nothing:
/// anything not spent is returned to `to` in the same transaction. Used once to turn a little HYPE into USDC.
contract OneShotNativeSwap is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager m) {
        pm = m;
    }

    function swap(PoolKey calldata key, uint128 minOut, address to) external payable returns (uint256 out) {
        require(msg.value > 0, "send native");
        require(address(uint160(Currency.unwrap(key.currency0))) == address(0), "currency0 must be native");
        out = abi.decode(pm.unlock(abi.encode(key, msg.value, minOut, to)), (uint256));
    }


    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not the manager");
        (PoolKey memory key, uint256 amountIn, uint128 minOut, address to) = abi.decode(data, (PoolKey, uint256, uint128, address));
        BalanceDelta d = pm.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );
        int128 a0 = BalanceDeltaLibrary.amount0(d);
        int128 a1 = BalanceDeltaLibrary.amount1(d);
        require(a0 < 0 && a1 > 0, "unexpected deltas");
        uint256 owe = uint256(uint128(-a0));
        uint256 got = uint256(uint128(a1));
        require(got >= minOut, "too little out");
        pm.settle{value: owe}();
        pm.take(key.currency1, to, got);
        if (amountIn > owe) {
            (bool ok,) = to.call{value: amountIn - owe}("");
            require(ok, "refund failed");
        }
        return abi.encode(got);
    }
}
