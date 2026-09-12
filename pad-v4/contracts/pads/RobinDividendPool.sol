// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";

/// @title RobinDividendPool — "dividends, not staking": snapshot-based holder rewards, no lock, no deposit
/// @notice Wires into RobinCurveV4's existing `staking` slot exactly like DualStaking does — same
/// IStakingFund/IStakingFundEth surfaces `setStaking()` already probes for — so a pad picks this OR DualStaking
/// at `setStaking()` time; this needed ZERO changes to RobinCurveV4 itself.
///
/// The trust shape deliberately mirrors ArrowDistributor (same merkle+bitmap self-claim pattern, same "funds
/// only ever leave via a valid leaf claim" guarantee), generalized to recurring EPOCHS instead of one immutable
/// root: periodically, an off-chain indexer snapshots real holder balances, computes a merkle tree of
/// (index, account, amount) leaves sized to that epoch's share of the accumulated pool, and the platform wallet
/// (the SAME address already trusted for setStaking/setFloor/setAmbush — no new trust assumption) opens a new
/// epoch with that root. Anyone can then self-claim their leaf — no lock, no stake, no action required beyond
/// having held the token at snapshot time.
///
/// ETH payouts are accrue-and-pull (claim() books to `ethOwed`, a separate `withdraw()` sends it) — matches
/// RobinCurveV4's own claimPlatform/claimCreator convention, so one recipient that can't accept ETH can never
/// brick anyone else's claim or withdrawal. Token payouts use safeTransfer directly inside the claim (matches
/// ArrowDistributor: a plain PadToken can't revert on transfer, so there's nothing to protect against).
///
/// WHAT THIS CONTRACT CANNOT DO: there is no withdraw/rescue/sweep/owner path over pooled or committed funds.
/// Money can only ever leave via (a) a valid merkle claim, always to the leaf's own `account`, or (b) sitting
/// unclaimed forever if a leaf's holder never claims it — same "unclaimed stays here forever" shape as
/// ArrowDistributor. Opening an epoch commits a root over the NEXT slice of the pool only; it can never touch
/// ETH/tokens already committed to a past epoch, and a bad root only misprices THAT epoch's slice — never
/// anyone else's already-open or already-paid epochs.
contract RobinDividendPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BitMaps for BitMaps.BitMap;

    address public immutable token; // the pad token — for setStaking()'s asset-match probe; never locked/staked
    IFeeWalletRegistry public immutable feeRegistry;

    uint256 public pendingEth; // ETH received via fundETH, not yet carved into an epoch
    uint256 public pendingToken; // token received via fundTokenPushed, not yet carved into an epoch
    uint256 public ethCommittedRemaining; // sum of all open ETH epochs' unclaimed remainders
    uint256 public tokenCommittedRemaining; // sum of all open token epochs' unclaimed remainders
    uint256 public ethEpochCount;
    uint256 public tokenEpochCount;

    struct Epoch {
        bytes32 root;
        uint256 remaining;
    }
    mapping(uint256 => Epoch) public ethEpochs;
    mapping(uint256 => Epoch) public tokenEpochs;
    mapping(uint256 => BitMaps.BitMap) private ethClaimed; // epochId => index => claimed?
    mapping(uint256 => BitMaps.BitMap) private tokenClaimed;

    mapping(address => uint256) public ethOwed; // accrue-and-pull

    event EthFunded(uint256 amount, uint256 pendingEth);
    event TokenFunded(uint256 amount, uint256 pendingToken);
    event EthEpochOpened(uint256 indexed epochId, bytes32 root, uint256 amount);
    event TokenEpochOpened(uint256 indexed epochId, bytes32 root, uint256 amount);
    event EthClaimed(uint256 indexed epochId, uint256 indexed index, address indexed account, uint256 amount);
    event TokenClaimed(uint256 indexed epochId, uint256 indexed index, address indexed account, uint256 amount);
    event EthWithdrawn(address indexed account, uint256 amount);

    error NotPlatform();
    error ZeroAddress();
    error EmptyRoot();
    error InsufficientPending();
    error AlreadyClaimed();
    error InvalidProof();
    error UnknownEpoch();
    error EthSendFailed();

    constructor(address token_, address feeRegistry_) {
        if (token_ == address(0) || feeRegistry_ == address(0)) revert ZeroAddress();
        token = token_;
        feeRegistry = IFeeWalletRegistry(feeRegistry_);
    }

    modifier onlyPlatform() {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        _;
    }

    // ---------------------------------------------------------------- funding (pushed by RobinCurveV4) --

    /// @notice Matches IStakingFundEth — RobinCurveV4 pushes ETH here exactly as it would a locked-staking sink.
    function fundETH(uint8 /*side*/ ) external payable {
        pendingEth += msg.value;
        emit EthFunded(msg.value, pendingEth);
    }

    /// @notice Matches IStakingFund — RobinCurveV4 transfers the leftover reserve token here BEFORE calling this
    /// (see RobinCurveV4._fundStaking/flushStaking), so `asset` is purely informational; we measure what
    /// actually landed via balance-diff, same reason DualStaking has to: the interface carries no amount param.
    /// Never reverts under normal operation — flushStaking() calls this WITHOUT a try/catch, so a revert here
    /// would brick that retry path; the only external state this touches is storage, no calls out.
    function fundTokenPushed(uint8 /*side*/ , address asset) external returns (uint256) {
        if (asset != token) return 0;
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 accounted = pendingToken + tokenCommittedRemaining;
        if (bal <= accounted) return 0; // nothing new (or a same-block double-notify) — never underflow
        uint256 fresh = bal - accounted;
        pendingToken += fresh;
        emit TokenFunded(fresh, pendingToken);
        return fresh;
    }

    // ---------------------------------------------------------------------- epochs (platform-gated) --

    /// @notice Carve a new ETH snapshot epoch out of the pending pool, committing its merkle root of
    /// (index, account, amount) leaves computed off-chain from a real holder-balance snapshot. Immutable once
    /// opened — same as ArrowDistributor's root. Gated to the same platform wallet already trusted for
    /// setStaking/setFloor/setAmbush; no new trust assumption over the existing system.
    function openEthEpoch(bytes32 root, uint256 amount) external onlyPlatform returns (uint256 epochId) {
        if (root == bytes32(0)) revert EmptyRoot();
        if (amount > pendingEth) revert InsufficientPending();
        pendingEth -= amount;
        ethCommittedRemaining += amount;
        epochId = ethEpochCount++;
        ethEpochs[epochId] = Epoch({root: root, remaining: amount});
        emit EthEpochOpened(epochId, root, amount);
    }

    /// @notice Same as openEthEpoch, for the token-denominated pool (the leftover reserve share this pool
    /// received via fundTokenPushed).
    function openTokenEpoch(bytes32 root, uint256 amount) external onlyPlatform returns (uint256 epochId) {
        if (root == bytes32(0)) revert EmptyRoot();
        if (amount > pendingToken) revert InsufficientPending();
        pendingToken -= amount;
        tokenCommittedRemaining += amount;
        epochId = tokenEpochCount++;
        tokenEpochs[epochId] = Epoch({root: root, remaining: amount});
        emit TokenEpochOpened(epochId, root, amount);
    }

    // ------------------------------------------------------------------------------------- claiming --

    function isEthClaimed(uint256 epochId, uint256 index) external view returns (bool) {
        return ethClaimed[epochId].get(index);
    }

    function isTokenClaimed(uint256 epochId, uint256 index) external view returns (bool) {
        return tokenClaimed[epochId].get(index);
    }

    /// @notice Claim `amount` ETH for `account` under ETH epoch `epochId`'s committed root. Permissionless —
    /// the caller may be the holder or anyone acting on their behalf; ETH is only ever OWED to `account`, never
    /// sent to the caller. Each (epoch, index) claims once. Books to `ethOwed`, pulled separately via
    /// `withdraw()` — so a claim can never fail because `account` itself can't receive ETH.
    function claimEth(uint256 epochId, uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        external
    {
        Epoch storage e = ethEpochs[epochId];
        if (e.root == bytes32(0)) revert UnknownEpoch();
        if (ethClaimed[epochId].get(index)) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, e.root, leaf)) revert InvalidProof();

        // clamp to the epoch's remaining balance — a rounding dust shortfall can't brick the tail claim
        // (ArrowDistributor's [audit L3] pattern, reused verbatim)
        uint256 pay = amount <= e.remaining ? amount : e.remaining;
        ethClaimed[epochId].set(index);
        e.remaining -= pay;
        ethCommittedRemaining -= pay;
        ethOwed[account] += pay;
        emit EthClaimed(epochId, index, account, pay);
    }

    /// @notice Claim `amount` token for `account` under token epoch `epochId`'s committed root. Same shape as
    /// ArrowDistributor.claim — pays inline via safeTransfer (a plain PadToken transfer can't revert).
    function claimToken(uint256 epochId, uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Epoch storage e = tokenEpochs[epochId];
        if (e.root == bytes32(0)) revert UnknownEpoch();
        if (tokenClaimed[epochId].get(index)) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, e.root, leaf)) revert InvalidProof();

        uint256 pay = amount <= e.remaining ? amount : e.remaining;
        tokenClaimed[epochId].set(index);
        e.remaining -= pay;
        tokenCommittedRemaining -= pay;
        emit TokenClaimed(epochId, index, account, pay);
        if (pay > 0) IERC20(token).safeTransfer(account, pay);
    }

    /// @notice Pull whatever ETH claimEth() has accrued for the caller. Permissionless, retriable: a failed send
    /// re-parks the amount instead of losing it, matching RobinCurveV4's claimCreator/claimPlatform pattern.
    function withdraw() external nonReentrant {
        uint256 amt = ethOwed[msg.sender];
        if (amt == 0) return;
        ethOwed[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        if (!ok) {
            ethOwed[msg.sender] = amt; // restore → retriable
            revert EthSendFailed();
        }
        emit EthWithdrawn(msg.sender, amt);
    }
}
