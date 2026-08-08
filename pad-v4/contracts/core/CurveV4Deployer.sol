// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeterministicDeployer} from "./DeterministicDeployer.sol";
import {RobinCurveV4} from "../pads/RobinCurveV4.sol";

/// @title CurveV4Deployer
/// @notice Holds `RobinCurveV4`'s creationCode so `CurvePadFactoryV4` doesn't have to — keeping the factory
/// under the 24KB code-size limit (the same offloading pattern the V3 stack used for its curve/token deployers).
/// Deploy is permissionless and safe: the CREATE2 address is bound to the exact ctor args, the shared
/// DeterministicDeployer idempotently ADOPTS a byte-identical pre-deploy, and only the factory ever authorizes a
/// curve (`isCurve`) or calls its factory-only `seed()` — so a stray deploy here confers nothing.
contract CurveV4Deployer {
    DeterministicDeployer public immutable deployer;

    constructor(address deployer_) {
        deployer = DeterministicDeployer(deployer_);
    }

    /// @param ctorArgs abi.encode(...) of the RobinCurveV4 constructor arguments
    function deploy(bytes32 salt, bytes calldata ctorArgs) external returns (address curve) {
        curve = deployer.deploy(salt, abi.encodePacked(type(RobinCurveV4).creationCode, ctorArgs));
    }
}
