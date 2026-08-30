// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PadRouter} from "../PadRouter.sol";

/// Test-only window onto `PadRouter._distribute`.
///
/// The fee split had a MEDIUM that survived a full test file because every test in it exercised
/// REGISTRATION and FLUSHING and none of them ever ran a swap through the split itself — so the branch
/// where the staking slice went missing was never executed. Driving a real swap needs a live Uniswap pool;
/// this calls the same internal function directly instead, which is what the missing coverage actually was.
contract RouterFeeProbe is PadRouter {
    constructor(address weth_, address owner_) PadRouter(weth_, owner_) {}

    function distribute(address token, uint256 value, uint256 feeBps, bool sellSide) external {
        _distribute(token, value, feeBps, sellSide);
    }
}
