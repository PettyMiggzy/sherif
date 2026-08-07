// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title FeeWalletRegistry
/// @notice THE ONLY mutable knob in the entire Robin V4 system: the platform fee wallet.
/// It moves only via a two-step, time-locked flow — the current owner (a multisig)
/// `proposePlatformFeeWallet`, waits `TIMELOCK`, then `commitPlatformFeeWallet`. The hook
/// reads `platformFeeWallet()` at accrual/claim time (forward-only), so a repoint only
/// affects fees claimed after it commits. There is no fee-rate change, no pause, no fund
/// movement, no LP path here — only this one address.
contract FeeWalletRegistry is Ownable2Step {
    uint256 public constant TIMELOCK = 2 days;

    address public platformFeeWallet;

    address public pendingWallet;
    uint256 public pendingEta; // 0 == no pending proposal

    event PlatformFeeWalletProposed(address indexed wallet, uint256 eta);
    event PlatformFeeWalletCommitted(address indexed wallet);
    event ProposalCancelled(address indexed wallet);

    error ZeroAddress();
    error NoProposal();
    error TimelockNotElapsed(uint256 eta);
    error RenounceDisabled();

    constructor(address initialWallet, address initialOwner) Ownable(initialOwner) {
        if (initialWallet == address(0)) revert ZeroAddress();
        platformFeeWallet = initialWallet;
        emit PlatformFeeWalletCommitted(initialWallet);
    }

    function proposePlatformFeeWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        pendingWallet = wallet;
        pendingEta = block.timestamp + TIMELOCK;
        emit PlatformFeeWalletProposed(wallet, pendingEta);
    }

    function commitPlatformFeeWallet() external onlyOwner {
        uint256 eta = pendingEta;
        if (eta == 0) revert NoProposal();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        address w = pendingWallet;
        platformFeeWallet = w;
        pendingWallet = address(0);
        pendingEta = 0;
        emit PlatformFeeWalletCommitted(w);
    }

    /// @notice [audit L5] Disabled — this is the system's only mutable knob; dropping ownership to zero
    /// would freeze `platformFeeWallet` forever. Ownership can only be transferred (2-step), never renounced.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function cancelProposal() external onlyOwner {
        if (pendingEta == 0) revert NoProposal();
        address w = pendingWallet;
        pendingWallet = address(0);
        pendingEta = 0;
        emit ProposalCancelled(w);
    }
}
