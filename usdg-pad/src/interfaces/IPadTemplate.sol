// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A plug-in that builds a new kind of pad for RobinPadFactory: a
/// different quote asset, a different launch token, new launch mechanics.
/// The factory owner approves each template. The factory charges the setup
/// fee, calls `deployPortal`, checks the new pad is wired to the factory's
/// own hook, PoolManager and treasury and charges Robin Labs' share, and only
/// then authorizes it on the hook. See docs/PAD-FACTORY.md.
interface IPadTemplate {
    /// @param padOwner Who runs the new pad: the buyer, or a house pad's named owner.
    /// @param platformShareBps Robin Labs' share the new pad must charge.
    /// @param config Template-specific settings, ABI-encoded.
    /// @return portal The new pad, a freshly deployed contract.
    function deployPortal(address padOwner, uint16 platformShareBps, bytes calldata config)
        external
        returns (address portal);
}

/// @notice Views every pad must expose. The factory reads them before
/// trusting a template's output. PadPortal has all of them.
interface IPadWiring {
    function poolManager() external view returns (address);
    function hook() external view returns (address);
    function treasury() external view returns (address);
    function platformShareBps() external view returns (uint16);
    function padOwner() external view returns (address);
}
