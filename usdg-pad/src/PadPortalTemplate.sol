// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PadPortal} from "./PadPortal.sol";
import {IPadTemplate} from "./interfaces/IPadTemplate.sol";

/// @notice Template #1: builds the standard PadPortal (USDC-quoted, plain
/// ERC-20 launches). RobinPadFactory creates this in its own constructor
/// and builds every `deployPad` / `deployHousePad` pad through it. It's a
/// separate contract only so the factory stays under the 24 KB contract
/// size limit. Only that factory may call it.
///
/// A PadPortal built here reports this template as its `factory()`; the
/// template's own `factory()` is the RobinPadFactory.
contract PadPortalTemplate is IPadTemplate {
    address public immutable factory;
    address public immutable poolManager;
    address public immutable hook;
    address public immutable treasury;
    address public immutable quoteAsset;
    address public immutable splitterImplementation;

    error NotFactory();

    constructor(address poolManager_, address hook_, address treasury_, address quoteAsset_, address splitterImplementation_) {
        factory = msg.sender;
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        quoteAsset = quoteAsset_;
        splitterImplementation = splitterImplementation_;
    }

    /// @param config `abi.encode(PadPortal.PadSettings)`.
    function deployPortal(address padOwner, uint16 platformShareBps, bytes calldata config)
        external
        returns (address portal)
    {
        if (msg.sender != factory) revert NotFactory();
        PadPortal.PadSettings memory settings = abi.decode(config, (PadPortal.PadSettings));
        portal = address(
            new PadPortal(
                poolManager, hook, treasury, quoteAsset, splitterImplementation, platformShareBps, padOwner, settings
            )
        );
    }
}
