// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RobinHolderToken} from "./RobinHolderToken.sol";

/// @notice Creates RobinHolderTokens for HolderPadPortal. A separate
/// contract only so HolderPadPortal stays under the 24 KB size limit. The
/// whole supply is always minted to the caller, so calling it directly
/// only ever creates a token that you hold and no pad knows about.
contract HolderTokenDeployer {
    function deploy(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        address quoteAsset,
        address poolManager,
        address splitter,
        uint256 holdersSlot
    ) external returns (address) {
        return address(
            new RobinHolderToken(name, symbol, totalSupply, msg.sender, quoteAsset, poolManager, splitter, holdersSlot)
        );
    }
}
