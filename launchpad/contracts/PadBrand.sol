// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PadBrand — the Robin pad-token address brand suffix
/// @notice Every coin launched through this factory lands on an address whose last four hex characters are
/// `1ab5`. The suffix is a VISIBLE, on-chain-checkable mark of authenticity: a coin whose address does not
/// end in `1ab5` did not come from a Robin pad, so impersonating a Robin launch costs a vanity-address mine
/// rather than a plain deploy.
///
/// It is a RULE, not a creator preference. There is no flag to disable it, no privileged bypass, and no
/// entrypoint that skips it — an earlier version of the salt work described the ending as "an option, not a
/// rule", and that is withdrawn. Enforcing it in the contract rather than in the launch tooling is the whole
/// point: an off-chain convention holds only as long as every client (our site, the Telegram bot, the SDK,
/// a direct caller) remembers to mine, which is the same "config-enforced, not contract-enforced" weakness
/// that has already been designed out elsewhere in this stack.
///
/// COST TO THE LAUNCHER: the caller mines `tokenSalt` off-chain until the predicted CREATE2 address carries
/// the suffix — 16 bits, so ~65k expected tries. On this pad each try is three keccaks (the factory folds
/// `msg.sender` in, the deployer folds the factory in, then CREATE2), measured a few seconds in node. The
/// on-chain check is a mask and a compare.
library PadBrand {
    /// @dev The last 4 hex chars of every Robin coin address.
    uint160 internal constant SUFFIX = 0x1ab5;
    /// @dev Low 16 bits == the last 4 hex characters.
    uint160 internal constant SUFFIX_MASK = 0xffff;

    /// @notice Thrown when a launch lands on an address that is not branded.
    error BadTokenSuffix(address token);

    /// @notice Require that `token` carries the Robin brand suffix.
    function requireBrand(address token) internal pure {
        if (uint160(token) & SUFFIX_MASK != SUFFIX) revert BadTokenSuffix(token);
    }

    /// @notice Non-reverting check, for tooling and views that want to test an address.
    function isBranded(address token) internal pure returns (bool) {
        return uint160(token) & SUFFIX_MASK == SUFFIX;
    }
}
