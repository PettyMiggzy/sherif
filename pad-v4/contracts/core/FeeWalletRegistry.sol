// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title FeeWalletRegistry
/// @notice The platform fee wallet. It moves only via a two-step, time-locked flow — the current owner (a multisig)
/// `proposePlatformFeeWallet`, waits `TIMELOCK`, then `commitPlatformFeeWallet`. The hook reads
/// `platformFeeWallet()` at accrual/claim time (forward-only), so a repoint only affects fees claimed after it
/// commits. Changing THIS registry entry cannot alter a fee rate, pause the system, move funds, or touch an LP.
///
/// [M-14] SECURITY — this address is the protocol's ROOT ADMIN KEY, not merely a payout destination. Beyond
/// receiving fees, `platformFeeWallet` is the AUTHORIZATION check for every one-shot per-pad wiring setter:
/// `RobinCurveV4.setStaking/setFloor/setAmbush`, `RobinFeeHook.setFloorRecipient`, and
/// `LockVault.setStakingRecipient`. Whoever holds it permanently, irreversibly determines where each of a pad's
/// value sinks routes (largest first: the staking stream, then the floor carves, the ambush share, and the locked
/// LP's token-leg fees). The 2-day timelock governs CHANGING this wallet, NOT what the wallet may do — the wiring
/// capability has no timelock on its use. Hold and operate this key with root-admin security, not treasury-receiver
/// security. (Separating the wiring role from the payout role is a deliberate trust-model choice left to the
/// operator — see M-14 in AUDITOR-HANDOFF.md.)
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
