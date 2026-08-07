// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuoteAdapter} from "../interfaces/IQuoteAdapter.sol";

/// @notice The clean quote case: native ETH. Never pausable, no yield, no external dependency.
/// `quote()` returns address(0) (the native sentinel / currency0 on every pad). `harvest` is a no-op.
contract EthQuoteAdapter is IQuoteAdapter {
    function quote() external pure returns (address) {
        return address(0);
    }

    function quoteDecimals() external pure returns (uint8) {
        return 18;
    }

    function harvest(address) external pure returns (uint256) {
        return 0;
    }
}
