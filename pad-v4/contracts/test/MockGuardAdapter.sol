// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST-ONLY stock guard adapter. Returns a settable scheduled corporate-action time so the
/// hook's beforeSwap curb (§3.4) can be exercised in- and out-of-window. `setRevert` proves the hook
/// treats a broken adapter as "no scheduled action" (never freezes trading).
contract MockGuardAdapter {
    uint256 public effectiveAt;
    bool public shouldRevert;

    function set(uint256 t) external {
        effectiveAt = t;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function scheduledEffectiveAt() external view returns (uint256) {
        require(!shouldRevert, "adapter down");
        return effectiveAt;
    }
}
