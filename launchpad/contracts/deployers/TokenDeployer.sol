// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchToken} from "../LaunchToken.sol";

/// @notice Deploys LaunchToken instances on behalf of the factory. Kept separate so the launched
/// token's creation bytecode is NOT inlined into LaunchpadFactory (contract-size limit).
/// @dev The deployed token's `factory` is set to the LaunchpadFactory (passed in), so all
/// onlyFactory hooks (enableTrading, seedBlocklist) answer to the launchpad, not this deployer.
contract TokenDeployer {
    function deploy(
        bytes32 salt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address factory,
        LaunchToken.GuardConfig calldata guard
    ) external returns (address) {
        // Bind the CREATE2 salt to the caller so an attacker calling this public, stateless deployer directly
        // with a victim's exact salt+args can't pre-occupy the token's target address and brick the launch
        // (matches LaunchTokenDeployer). NOTE: only the legacy LaunchpadFactory uses this deployer — the live
        // CurvePad stack uses LaunchTokenDeployer — but the defect is real if that factory is ever deployed.
        bytes32 s = keccak256(abi.encodePacked(msg.sender, salt));
        return address(new LaunchToken{salt: s}(name, symbol, supply, factory, guard));
    }
}
