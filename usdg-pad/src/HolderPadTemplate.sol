// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PadPortal} from "./PadPortal.sol";
import {HolderPadPortal} from "./HolderPadPortal.sol";
import {IPadTemplate} from "./interfaces/IPadTemplate.sol";

/// @notice Template #2 for TrollPadFactory: builds HolderPadPortals, pads
/// whose creators can give holders a share of the fees in USDC. Same
/// settings as a standard pad (`config` is `abi.encode(PadPortal.PadSettings)`).
///
/// Deployed by the factory owner, then approved with
/// `setTemplateApproved`. Only that factory may call it, and the factory
/// checks every pad it returns (hook, PoolManager, treasury, Troll's share,
/// owner) before authorizing it on the hook.
contract HolderPadTemplate is IPadTemplate {
    address public immutable factory;
    address public immutable poolManager;
    address public immutable hook;
    address public immutable treasury;
    address public immutable quoteAsset;
    address public immutable splitterImplementation;
    address public immutable holderTokenDeployer;

    error NotFactory();
    error ZeroAddress();

    constructor(
        address factory_,
        address poolManager_,
        address hook_,
        address treasury_,
        address quoteAsset_,
        address splitterImplementation_,
        address holderTokenDeployer_
    ) {
        if (
            factory_ == address(0) || poolManager_ == address(0) || hook_ == address(0) || treasury_ == address(0)
                || quoteAsset_ == address(0) || splitterImplementation_ == address(0) || holderTokenDeployer_ == address(0)
        ) revert ZeroAddress();
        factory = factory_;
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        quoteAsset = quoteAsset_;
        splitterImplementation = splitterImplementation_;
        holderTokenDeployer = holderTokenDeployer_;
    }

    function deployPortal(address padOwner, uint16 platformShareBps, bytes calldata config)
        external
        returns (address portal)
    {
        if (msg.sender != factory) revert NotFactory();
        PadPortal.PadSettings memory settings = abi.decode(config, (PadPortal.PadSettings));
        portal = address(
            new HolderPadPortal(
                poolManager,
                hook,
                treasury,
                quoteAsset,
                splitterImplementation,
                platformShareBps,
                padOwner,
                settings,
                holderTokenDeployer
            )
        );
    }
}
