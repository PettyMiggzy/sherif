// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title RobinBurnTracker — "burn-boost": public, permissionless self-burn with an on-chain per-account tally
/// @notice A single contract, deployed ONCE, shared across every Robin pad token — same "deployed once, reused
/// everywhere" shape as Disperse. It has no per-pad wiring and nothing to authorize: any holder of ANY ERC20
/// burns their own tokens through it, and the contract remembers exactly how much each (token, account) pair
/// has burned, forever.
///
/// This is the on-chain half of "burn-boost" reward weighting (see ROBIN-PAD-NEXT-GEN-IDEAS.md, "Rewards —
/// moving past plain staking": burning your own tokens increases YOUR share of the same guaranteed reward pool
/// — not a separate lottery, not winner-take-all). The off-chain indexer that computes each
/// `RobinDividendPool` snapshot epoch reads `burnedBy(token, account)` alongside the account's live balance and
/// folds both into that epoch's leaf amount however the product wants to weight it (e.g. balance + burned, or
/// balance × a burn multiplier) — the weighting FORMULA is deliberately not on-chain, so it can be tuned per
/// epoch without a contract upgrade. This contract's only job is to make "how much has this account burned"
/// an honest, tamper-proof, cheaply-queryable on-chain fact.
///
/// PadToken is a deliberately-immutable plain OZ ERC20 with no `burn` selector (see RobinTokenTreasury's own
/// note) — a transfer to the canonical dead address is how supply is retired here, same convention used
/// throughout this repo. `burn()` pulls via `transferFrom`, so nothing here can move a token the caller didn't
/// approve, and it can only ever move it to the dead address — never to this contract, never to anyone else.
///
/// WHAT THIS CONTRACT CANNOT DO: there is no owner, no pause, no rescue, no un-burn. `burnedBy` only ever
/// increases. A caller burns only their own tokens — there is no "burn on behalf of" path, so nobody can
/// inflate another account's tally without that account's own approval + transferFrom pulling from THEM
/// (impossible: `msg.sender` is both the payer and the credited account, always the same address).
contract RobinBurnTracker {
    using SafeERC20 for IERC20;

    /// @dev The canonical burn sink — tokens sent here are unspendable (no key controls it).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    mapping(address token => uint256) public totalBurned;
    mapping(address token => mapping(address account => uint256)) public burnedBy;

    event Burned(address indexed token, address indexed account, uint256 amount, uint256 totalForAccount);

    error ZeroAmount();

    /// @notice Burn `amount` of `token` from the caller. Permissionless, self-serve: pulls via `transferFrom`
    /// (the caller must have approved this contract first), so this can only ever burn tokens the caller
    /// themselves controls, and only ever sends them to the dead address.
    function burn(address token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, DEAD, amount);
        totalBurned[token] += amount;
        uint256 newTotal = burnedBy[token][msg.sender] + amount;
        burnedBy[token][msg.sender] = newTotal;
        emit Burned(token, msg.sender, amount, newTotal);
    }
}
