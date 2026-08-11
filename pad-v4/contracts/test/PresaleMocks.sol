// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPresaleVaultMock {
    function deposit() external payable;
    function refund() external;
    function refundTo(address to) external;
}

/// @dev A contract contributor with NO payable receive/fallback: it can fund a presale (deposit forwards the ETH it
/// was called with) but cannot accept a plain ETH send — so refund() to itself must fail while refundTo(EOA) rescues
/// it. Proves the fail-path escape hatch mirrors the success-path claimTo().
contract PresaleDepositor {
    function deposit(address vault) external payable {
        IPresaleVaultMock(vault).deposit{value: msg.value}();
    }

    function callRefund(address vault) external {
        IPresaleVaultMock(vault).refund();
    }

    function callRefundTo(address vault, address to) external {
        IPresaleVaultMock(vault).refundTo(to);
    }
    // deliberately NO receive()/fallback() — a plain ETH transfer to this contract reverts
}
