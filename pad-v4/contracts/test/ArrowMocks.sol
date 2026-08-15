// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev A "dev" contract with NO payable receive/fallback. It can call ArrowLauncher.launch (forwarding value via a
/// low-level call), but cannot accept the ETH refund the launcher sends back — so its launch must revert atomically
/// (EthSendFailed bubbles up), proving a contract dev that can't receive ETH bricks only its OWN launch with no loss.
contract ArrowRejectDev {
    function doLaunch(address launcher, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = launcher.call{value: msg.value}(data);
        if (!ok) {
            // bubble the revert reason (the launcher's EthSendFailed) up to the test
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
    // deliberately NO receive()/fallback() — a plain ETH refund to this contract reverts
}
