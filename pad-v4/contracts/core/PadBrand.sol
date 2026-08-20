// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PadBrand — the Robin pad-token address brand suffix
/// @notice Every pad token launched through a Robin factory lands on an address whose last four hex
/// characters are `faf0`. The suffix is a VISIBLE, on-chain-checkable mark of authenticity: a coin that
/// does not end in `faf0` did not come from a Robin factory, so impersonating a Robin launch requires
/// mining a colliding vanity address rather than simply deploying a lookalike token.
///
/// This is enforced in the CONTRACT, not in the launch tooling, and deliberately so: an off-chain-only
/// convention would hold merely as long as every client (our own UI, partner bots, direct callers)
/// remembered to mine — exactly the "config-enforced, not contract-enforced" weakness that round-3
/// finding F1 was restructured to eliminate. There is no flag to disable it and no privileged bypass.
///
/// COST TO THE LAUNCHER: the caller must mine `tokenSalt` off-chain until the predicted CREATE2 address
/// carries the suffix — 16 bits, so ~65k expected keccak tries (measured ~2s in node; see
/// `scripts/mine.js` `mineTokenSalt`). The check itself is a mask+compare, so on-chain cost is trivial.
/// The failure is LOUD and lands before any pool/LP state is written, so an unmined salt wastes gas but
/// can never half-create a pad.
library PadBrand {
    /// @dev The last 4 hex chars of every Robin pad token address.
    uint160 internal constant SUFFIX = 0xfaf0;
    /// @dev Low 16 bits == the last 4 hex characters.
    uint160 internal constant SUFFIX_MASK = 0xffff;

    /// @notice Thrown when a launch supplies a `tokenSalt` whose CREATE2 address is not branded.
    error BadTokenSuffix(address token);

    /// @notice Require that `token` carries the Robin brand suffix.
    function requireBrand(address token) internal pure {
        if (uint160(token) & SUFFIX_MASK != SUFFIX) revert BadTokenSuffix(token);
    }

    /// @notice Non-reverting check, for tooling//views that want to test an address.
    function isBranded(address token) internal pure returns (bool) {
        return uint160(token) & SUFFIX_MASK == SUFFIX;
    }
}
