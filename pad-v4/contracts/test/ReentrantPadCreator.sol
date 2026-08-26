// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ReentrantPadCreator — a hostile `cfg.creator` for the M-27 ordering regression
/// @notice PadFactory.launch refunds leftover ETH to `cfg.creator` with a raw call near the END of the
/// launch. That call hands control to an arbitrary contract while the launch is still in flight, and it is
/// the only re-entrancy window the function has. The M-27 uniqueness gate is therefore only airtight if
/// `poolOf[token]` is written BEFORE that point — otherwise a creator could re-enter here and open a second
/// pool over the same pad token inside the same transaction.
///
/// This mock takes that window and records what happens instead of reverting: a revert inside `receive`
/// would surface as `RefundFailed` and tell us nothing about which guard actually fired.
contract ReentrantPadCreator {
    address public factory;
    bytes public payload; // abi.encodeCall(PadFactory.launch, (cfg, tokenSalt, hookSalt))
    bool public armed;
    bool public reentered;
    bool public innerOk;
    bytes4 public innerError;

    function arm(address factory_, bytes calldata payload_) external {
        factory = factory_;
        payload = payload_;
        armed = true;
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // one shot: the inner launch's own refund must not recurse forever
        reentered = true;
        // value 0 is deliberate — the uniqueness gate sits before any seeding, so a claimed token must be
        // rejected there and never reach the point where the seed amount could matter.
        (bool ok, bytes memory ret) = factory.call(payload);
        innerOk = ok;
        if (!ok && ret.length >= 4) {
            bytes4 sel;
            assembly {
                sel := mload(add(ret, 0x20))
            }
            innerError = sel;
        }
    }
}
