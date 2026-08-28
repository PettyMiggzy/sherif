// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev A minimal ERC-1271 smart-contract wallet: valid iff the signature is exactly `magic`.
contract Mock1271Wallet {
    bytes public expected;
    constructor(bytes memory expected_) { expected = expected_; }
    function isValidSignature(bytes32, bytes calldata sig) external view returns (bytes4) {
        return keccak256(sig) == keccak256(expected) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @dev An "ERC-1271 wallet" that eats every drop of gas it is given. Proves a caller-named address cannot
/// burn the operator's gas on a relayed spend.
contract GasBurner1271 {
    uint256 public sink;
    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        while (true) { sink++; }
        return bytes4(0x1626ba7e);
    }
}

/// @dev A payee that always rejects ETH, so the withdraw failure path is reachable.
contract RejectEth {
    receive() external payable { revert("no"); }
}
