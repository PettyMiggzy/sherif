// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeterministicDeployer} from "./DeterministicDeployer.sol";
import {RobinFeeHook} from "../hooks/RobinFeeHook.sol";

/// @title FeeHookDeployer
/// @notice Holds `RobinFeeHook`'s creationCode (10.6 KB) so a pad factory doesn't have to — the same offloading
/// pattern `CurveV4Deployer` already uses for `RobinCurveV4`. Every factory that inlines the hook's creationCode
/// grows byte-for-byte with the hook, and `StockPadFactory` had only ~640 bytes of headroom left before the
/// [R3-H5 P1] gate pushed it past EIP-170. Offloading decouples factory size from hook size permanently.
///
/// ADDRESSES ARE UNCHANGED BY THIS INDIRECTION: the CREATE2 is still performed by the shared
/// `DeterministicDeployer` over byte-identical init code, so `keccak256(0xff ++ deployer ++ salt ++ initCodeHash)`
/// is exactly what it was — mined hook salts, `scripts/mine.js`, and every predicted address still hold.
///
/// Deploy is permissionless and safe for the same reason `CurveV4Deployer`'s is: the address is bound to the
/// exact ctor args, the shared deployer idempotently ADOPTS a byte-identical pre-deploy, and a hook only ever
/// does anything once its factory registers a pool on it — so a stray deploy here confers nothing.
contract FeeHookDeployer {
    DeterministicDeployer public immutable deployer;

    constructor(address deployer_) {
        deployer = DeterministicDeployer(deployer_);
    }

    /// @param ctorArgs abi.encode(poolManager, factory, feeRegistry, padToken)
    function deploy(bytes32 salt, bytes calldata ctorArgs) external returns (address hook) {
        hook = deployer.deploy(salt, abi.encodePacked(type(RobinFeeHook).creationCode, ctorArgs));
    }
}
