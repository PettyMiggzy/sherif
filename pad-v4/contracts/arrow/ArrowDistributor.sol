// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArrowDistributor — a no-withdraw merkle airdrop for an Arrow migration launch
/// @notice The Arrow launcher buys out the whole curve and hands the bought supply HERE, to be claimed by the dev's
/// migrating holders against a committed merkle root of (index, account, amount) leaves. The dev commits the root
/// (the hash of their holder snapshot / CSV) at construction — it is IMMUTABLE, so the recipient set can never be
/// swapped after the fact. Holders (or anyone, on their behalf — funds always go to the leaf's `account`) self-claim.
///
/// TRUST SHAPE — this is the "no dev wallet holds the bag" guarantee:
///   • NO withdraw / rescue / sweep / owner path exists. Token can ONLY leave via a valid merkle claim to the
///     account named in the leaf. The deployer cannot pull the supply back, redirect it, or change the root.
///   • Each leaf is claimable exactly once (a bitmap), so the total paid out is bounded by the committed amounts.
///   • If the leaf amounts sum to the funded supply, full claims drain the contract to ZERO. Any unclaimed remainder
///     stays here FOREVER (there is no path out) — unclaimed is burned-in-place, never returned to the dev.
///
/// The token is a plain immutable PadToken (no receive hook, no blocklist, transfer can't revert), so a single
/// claim cannot brick others; each claim is independent (self-claim, not a batch push).
contract ArrowDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BitMaps for BitMaps.BitMap;

    IERC20 public immutable token; // the pad token being distributed
    bytes32 public immutable merkleRoot; // commits the ordered (index, account, amount) holder set — immutable

    BitMaps.BitMap private claimed; // index => claimed?
    uint256 public totalClaimed; // lifetime token claimed (transparency; the contract ends at 0 outstanding)

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);

    error ZeroAddress();
    error EmptyRoot();
    error AlreadyClaimed();
    error InvalidProof();

    constructor(address token_, bytes32 merkleRoot_) {
        if (token_ == address(0)) revert ZeroAddress();
        if (merkleRoot_ == bytes32(0)) revert EmptyRoot();
        token = IERC20(token_);
        merkleRoot = merkleRoot_;
    }

    /// @notice True once leaf `index` has been claimed.
    function isClaimed(uint256 index) public view returns (bool) {
        return claimed.get(index);
    }

    /// @notice Claim `amount` for `account` against the committed root. Permissionless — the caller may be the holder
    /// or anyone acting on their behalf; the tokens ALWAYS go to `account`, never the caller. Each index claims once.
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (claimed.get(index)) revert AlreadyClaimed();
        // Double-hashed leaf (OZ convention) — prevents a leaf preimage from colliding with an internal node.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        claimed.set(index); // effects before interaction (bitmap marks the index spent)
        totalClaimed += amount;
        token.safeTransfer(account, amount);
        emit Claimed(index, account, amount);
    }
}
