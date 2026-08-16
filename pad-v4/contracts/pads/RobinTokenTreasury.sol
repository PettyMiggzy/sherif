// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title RobinTokenTreasury — the per-pad TOKEN-fee split + public burn treasury
/// @notice The platform takes ETH only and never holds pad tokens: the TOKEN-side (currency1) LP fee streams that
/// carry the 70/30 split terminate HERE, never on the treasury key. Which streams those are is PATH-SCOPED [R3-F3]:
///   • PadFactory (seed-LP) pads — the `LockVault` sell-leg (the platform wires `setStakingRecipient(treasury)`
///     post-launch) and `RobinFloorVault.tokenSink`.
///   • Curve pads — `RobinFloorVault.tokenSink` and the `RobinAmbushVault` token leg (its immutable
///     `stakingRecipient`, chosen at deploy). On the standard curve runbook (`setStaking` BEFORE `graduate()`)
///     the `LockVault` sell-leg does NOT come here: `registerLaunch` hard-wires it to `curve.staking` (the pool)
///     — 100% staking, and a non-zero register can never be rewired. The ARROW sub-path is the exception: it
///     graduates with `staking` unset, the lock registers 0, and the runbook wires the sell-leg post-hoc to THIS
///     treasury (70/30, see ARROW.md). The graduation reservoir always goes 100% to the pool on every curve
///     sub-path (`setStaking` rejects this splitter's shape).
/// Each source forwards its token here by a plain transfer.
///
/// On `distribute()` (permissionless) the freshly-arrived token is split:
///   • `TO_STAKING_BPS` (70%)  → the pad's staking pool (holders earn it; booked into rewards by the keeper's
///     existing `fundTokenPushed` call, exactly as before — this contract just changes the SOURCE of that token),
///   • the remainder (30%)      → RETAINED here as `burnReserve`, the transparent "buyback/burn" pool anyone can read.
///
/// `burn()` is CREATOR-ONLY and sends the whole `burnReserve` to the canonical burn address `0x…dEaD` (PadToken is a
/// deliberately-immutable plain ERC20 with no `burn` selector, so a dead-address transfer is how supply is retired —
/// the tokens are provably unspendable forever). The creator decides WHEN to burn and pays the gas.
///
/// There is NO withdraw/rescue/owner path: token can only ever leave to the staking pool (via distribute) or to the
/// dead address (via a creator burn). Neither the creator nor the platform can ever pull a pad token to a wallet.
contract RobinTokenTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev The canonical burn sink. Tokens sent here are unspendable (no key controls it) — a permanent supply
    /// retirement without needing a `burn` selector on the immutable PadToken.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant BPS = 10_000;
    uint16 public constant TO_STAKING_BPS = 7_000; // 70% of the token-side LP fee → staking; the 30% remainder burns

    IERC20 public immutable token; // the pad token (currency1)
    address public immutable staking; // the pad's DualStaking pool — receives the 70% staking share
    address public immutable creator; // the only address that may trigger a burn of the retained 30%

    uint256 public burnReserve; // token retained for the creator to burn (the transparent treasury balance)
    uint256 public totalToStaking; // lifetime token forwarded to staking (transparency)
    uint256 public totalBurned; // lifetime token burned (transparency)

    event Distributed(uint256 toStaking, uint256 toBurnReserve, uint256 burnReserveTotal);
    event Burned(address indexed by, uint256 amount, uint256 lifetimeBurned);

    error ZeroAddress();
    error NotCreator();
    error NothingToBurn();

    constructor(address token_, address staking_, address creator_) {
        if (token_ == address(0) || staking_ == address(0) || creator_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        staking = staking_;
        creator = creator_;
    }

    /// @notice Split the freshly-arrived token: 70% to staking, 30% retained as the burn reserve. Permissionless —
    /// the funds only ever go to the two fixed destinations, never the caller. Idempotent: the retained 30% is
    /// excluded from `fresh` so repeated calls never re-split it.
    function distribute() external nonReentrant returns (uint256 toStaking) {
        uint256 bal = token.balanceOf(address(this));
        uint256 reserve = burnReserve;
        if (bal <= reserve) return 0; // nothing new since the last distribute (or only the retained reserve on hand)
        uint256 fresh = bal - reserve;
        toStaking = (fresh * TO_STAKING_BPS) / BPS;
        uint256 toBurn = fresh - toStaking; // remainder (dust conserved into the burn reserve)
        burnReserve = reserve + toBurn;
        totalToStaking += toStaking;
        if (toStaking > 0) token.safeTransfer(staking, toStaking);
        emit Distributed(toStaking, toBurn, burnReserve);
    }

    /// @notice Burn the retained treasury (send it to the dead address). CREATOR-ONLY: the creator decides when to
    /// burn and pays the gas. Reverts if there is nothing retained yet.
    function burn() external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        amount = burnReserve;
        if (amount == 0) revert NothingToBurn();
        burnReserve = 0;
        totalBurned += amount;
        token.safeTransfer(DEAD, amount);
        emit Burned(msg.sender, amount, totalBurned);
    }

    /// @notice Token that would go to staking on the next distribute() (the not-yet-split arrivals). Read-only.
    function pendingStaking() external view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        uint256 reserve = burnReserve;
        return bal > reserve ? bal - reserve : 0;
    }
}
