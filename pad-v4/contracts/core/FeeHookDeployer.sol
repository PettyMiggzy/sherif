// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeterministicDeployer} from "./DeterministicDeployer.sol";
import {RobinFeeHook} from "../hooks/RobinFeeHook.sol";

/// @title FeeHookDeployer
/// @notice Holds `RobinFeeHook`'s creationCode so the three pad factories don't have to — the same offloading
/// pattern `CurveV4Deployer` already uses for `RobinCurveV4`. All three factories embedded the hook's init-code
/// inline, so every byte added to the hook was added to each of them; `StockPadFactory` was within 640 bytes of
/// the 24,576 EIP-170 limit before the [H-5] floor gate landed. Offloading is what makes that change deployable.
///
/// CREATE2 derivation is UNCHANGED: this contract forwards to the SAME shared `DeterministicDeployer`, so the
/// mined hook address is still `keccak256(0xff ++ deterministicDeployer ++ salt ++ keccak256(initCode))`.
/// `scripts/mine.js` needs no change — only the init-code hash moves, and that already moves whenever the hook's
/// bytecode does.
///
/// Deploy is permissionless and safe, exactly as for `CurveV4Deployer`: the address is bound to the exact ctor
/// args, the shared deployer idempotently ADOPTS a byte-identical pre-deploy, and a hook confers nothing until a
/// factory calls its factory-only `registerPool`.
contract FeeHookDeployer {
    DeterministicDeployer public immutable deployer;

    error ZeroAddress();

    constructor(address deployer_) {
        if (deployer_ == address(0)) revert ZeroAddress();
        deployer = DeterministicDeployer(deployer_);
    }

    /// @param ctorArgs abi.encode(poolManager, factory, feeRegistry, padToken)
    function deploy(bytes32 salt, bytes calldata ctorArgs) external returns (address hook) {
        hook = deployer.deploy(salt, abi.encodePacked(type(RobinFeeHook).creationCode, ctorArgs));
    }

    /// @notice The init-code hash the factories' mined salts are derived against. Exposed so `scripts/mine.js`,
    /// `check-wiring.js` and the tests can read it from the chain instead of re-deriving it from artifacts.
    function hookInitCodeHash(bytes calldata ctorArgs) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(RobinFeeHook).creationCode, ctorArgs));
    }
}
