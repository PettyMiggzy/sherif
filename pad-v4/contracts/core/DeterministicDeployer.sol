// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DeterministicDeployer
/// @notice Minimal CREATE2 factory. Deployed FIRST in the bootstrap; its address is then
/// pinned as a constant everywhere hook-address mining happens, because the mined salt
/// depends on `keccak256(0xff ++ deployer ++ salt ++ initCodeHash)` — a different deployer
/// address changes every mined hook address. Do NOT assume the canonical 0x4e59… CREATE2
/// deployer exists on this Orbit chain; we deploy and pin our own.
contract DeterministicDeployer {
    error DeployFailed();
    error AlreadyDeployed();

    event Deployed(address indexed addr, bytes32 indexed salt);

    /// @notice Deploy `initCode` at the CREATE2 address for `salt`, or ADOPT it if already present.
    /// [audit L6] The address is bound to keccak256(initCode), so any code already at `predicted` was
    /// necessarily created from this exact `initCode` — a byte-identical deployment. So instead of
    /// reverting AlreadyDeployed (which lets anyone brick a launch by front-running an identical
    /// pre-deploy), we return the existing address. Griefing a launch is impossible; the outcome is
    /// the same contract either way. (No value is forwarded on adoption; our callers deploy value-free.)
    function deploy(bytes32 salt, bytes calldata initCode) external payable returns (address addr) {
        address predicted = addressOf(salt, keccak256(initCode));
        if (predicted.code.length != 0) return predicted;

        bytes memory code = initCode;
        assembly ("memory-safe") {
            addr := create2(callvalue(), add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        emit Deployed(addr, salt);
    }

    /// @notice The CREATE2 address this deployer would produce for (salt, initCodeHash).
    function addressOf(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }
}
