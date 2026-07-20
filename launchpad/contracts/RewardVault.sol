// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IPadRouterFloor {
    /// @notice Donate ETH to a coin's floor escrow; the router later flushes it into that coin's Bond Bounty.
    function donateFloor(address token) external payable;
}

/// @title RewardVault — per-coin trader & holder reward custody, capped and Merkle-claimed
/// @notice The second, ADDITIVE half of the Pad fee model. On every trade PadRouter forwards two new
/// 0.25% legs here as raw ETH — the BUY leg funds that coin's **trader** pool (rewarding net accumulation),
/// the SELL leg funds its **holder** pool (rewarding size×time holding). This contract does the one thing
/// the chain must do trustlessly: **custody the ETH and cap what can ever leave**. It never scores.
///
/// The split of responsibility (the whole design):
///   • CHAIN (here) custodies money and enforces a per-(coin, epoch, side) conservation cap — the fuse.
///   • INDEXER computes the exact weights off-chain (true net-volume in token units, exact balance-seconds),
///     which are path/time-dependent and clamp-at-zero — things on-chain can't compute cheaply or correctly.
///   • A single global MERKLE ROOT per epoch is the minimal bridge; each leaf binds (epoch, coin, side, user,
///     amount) so a leaf is spendable ONLY against that exact coin/side/epoch pot.
///
/// What the cap buys you: even a fully malicious or buggy root can, worst case, misallocate ONE coin's own
/// fees among that coin's own addresses for ONE side — never cross-coin, never cross-side, never protocol
/// theft. Layered on top: a frozen scoring `algoHash` + IPFS-pinned leaf set (anyone can recompute and prove
/// a mismatch), a challenge window, and a guardian veto that can only BLOCK a bad root, never move funds.
///
/// Existing platform/creator fees are untouched — those live entirely in PadRouter's escrows. This vault only
/// ever sees the two new 0.25% legs.
contract RewardVault is Ownable2Step, ReentrancyGuard {
    enum Side {
        Traders, // 0 — funded by the 0.25% BUY leg; rewards net token accumulation
        Holders // 1 — funded by the 0.25% SELL leg; rewards balance-seconds
    }

    struct Pot {
        uint128 traderPot; // Σ of 0.25% buy legs for (coin, epoch)
        uint128 holderPot; // Σ of 0.25% sell legs for (coin, epoch)
    }

    struct EpochRoot {
        bytes32 root; // global Merkle root over ALL coins' leaves for this epoch
        bytes32 algoHash; // keccak of the frozen scoring spec + reference impl
        uint64 postedAt; // finalizes at postedAt + challengeWindow
        bool vetoed; // guardian kill switch — blocks finalization only
    }

    // ── immutable wiring ──
    address public immutable router; // only PadRouter may accrue
    uint256 public immutable EPOCH; // epoch length in seconds (e.g. 1 days)

    // ── roles / timing (owner-settable) ──
    address public poster; // indexer operator key — posts roots
    address public guardian; // multisig — veto only, no custody
    uint64 public finalityDelay; // a root may only cover blocks this old (reorg safety)
    uint64 public challengeWindow; // time after postRoot before claims open

    // ── state ──
    mapping(address => mapping(uint256 => Pot)) public pot; // coin => epoch => pot
    mapping(uint256 => EpochRoot) public epochRoot; // epoch => root data
    mapping(address => mapping(uint256 => uint128)) public claimedTraders; // coin => epoch => paid
    mapping(address => mapping(uint256 => uint128)) public claimedHolders;
    mapping(uint256 => string) public dataURI; // epoch => IPFS/Arweave pin of the full leaf set
    mapping(bytes32 => bool) public leafClaimed; // per-leaf replay guard
    mapping(address => mapping(uint256 => bool)) public swept; // coin => epoch => swept

    error OnlyRouter();
    error OnlyPoster();
    error OnlyGuardian();
    error BadEpoch();
    error RootExists();
    error NoRoot();
    error Vetoed();
    error TooEarly();
    error AlreadyClaimed();
    error BadProof();
    error CapExceeded();
    error PayFail();
    error ZeroAddr();

    event Accrued(address indexed coin, uint256 indexed epoch, Side side, uint256 amount);
    event RootPosted(uint256 indexed epoch, bytes32 root, bytes32 algoHash, string uri);
    event EpochVetoed(uint256 indexed epoch);
    event Claimed(uint256 indexed epoch, address indexed coin, address indexed user, Side side, uint256 amount);
    event Swept(uint256 indexed epoch, address indexed coin, uint256 traders, uint256 holders);
    event PosterSet(address poster);
    event GuardianSet(address guardian);

    constructor(
        address router_,
        address poster_,
        address guardian_,
        uint256 epochLen_,
        uint64 finalityDelay_,
        uint64 challengeWindow_,
        address owner_
    ) Ownable(owner_) {
        if (router_ == address(0) || poster_ == address(0) || guardian_ == address(0)) revert ZeroAddr();
        require(epochLen_ >= 1 hours, "epoch too short");
        router = router_;
        EPOCH = epochLen_;
        poster = poster_;
        guardian = guardian_;
        finalityDelay = finalityDelay_;
        challengeWindow = challengeWindow_;
    }

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / EPOCH;
    }

    // ───────────────────────────────────────────────────────────── accrue ──
    /// @notice Called by PadRouter on every trade with the 0.25% reward leg as raw ETH. One warm SSTORE
    /// (the (coin,epoch) slot is written every trade in the epoch), no external call, no user state — this
    /// is the gas win. Attributes to the CURRENT epoch, i.e. the epoch the trade happens in.
    function accrue(address coin, Side side) external payable {
        if (msg.sender != router) revert OnlyRouter();
        if (msg.value == 0) return;
        uint256 e = currentEpoch();
        Pot storage p = pot[coin][e];
        if (side == Side.Traders) p.traderPot += uint128(msg.value);
        else p.holderPot += uint128(msg.value);
        emit Accrued(coin, e, side, msg.value);
    }

    // ──────────────────────────────────────────────────────────── postRoot ──
    /// @notice The indexer posts one global root for a fully-ended, finalized epoch. Write-once per epoch
    /// unless the epoch was vetoed (then a corrected root may replace the bad one). Gated behind
    /// `finalityDelay` past the epoch's end so a root can never cover reorg-able blocks.
    function postRoot(uint256 epoch, bytes32 root, bytes32 algoHash, string calldata uri) external {
        if (msg.sender != poster) revert OnlyPoster();
        if (root == bytes32(0)) revert NoRoot();
        if (epoch >= currentEpoch()) revert BadEpoch(); // epoch must be fully ended
        if (block.timestamp < (epoch + 1) * EPOCH + finalityDelay) revert TooEarly(); // reorg safety
        EpochRoot storage er = epochRoot[epoch];
        // write-once, EXCEPT a vetoed epoch may be re-posted with a corrected root
        if (er.root != bytes32(0) && !er.vetoed) revert RootExists();
        er.root = root;
        er.algoHash = algoHash;
        er.postedAt = uint64(block.timestamp);
        er.vetoed = false; // re-posting clears the veto; the fresh challenge window restarts
        dataURI[epoch] = uri;
        emit RootPosted(epoch, root, algoHash, uri);
    }

    /// @notice Guardian brake: block finalization of a posted-but-not-yet-final root proven wrong against the
    /// pinned data. Cannot move funds. The poster then re-posts a corrected root.
    function veto(uint256 epoch) external {
        if (msg.sender != guardian) revert OnlyGuardian();
        EpochRoot storage er = epochRoot[epoch];
        if (er.root == bytes32(0)) revert NoRoot();
        er.vetoed = true;
        emit EpochVetoed(epoch);
    }

    // ─────────────────────────────────────────────────────────────── claim ──
    /// @notice Claim your reward for (epoch, coin, side). The amount is embedded in the leaf, so this is a
    /// pure Merkle verify + per-side conservation-cap check + ETH transfer. User pays their own gas.
    function claim(uint256 epoch, address coin, Side side, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
    {
        EpochRoot storage er = epochRoot[epoch];
        if (er.root == bytes32(0)) revert NoRoot();
        if (er.vetoed) revert Vetoed();
        if (block.timestamp < er.postedAt + challengeWindow) revert TooEarly(); // past the challenge window

        // leaf binds epoch+coin+side+user+amount → spendable only against that exact pot slice.
        // Double-hash matches @openzeppelin/merkle-tree's standard leaf encoding (second-preimage safe).
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epoch, coin, side, msg.sender, amount))));
        if (leafClaimed[leaf]) revert AlreadyClaimed();
        if (!MerkleProof.verify(proof, er.root, leaf)) revert BadProof();
        // amount is bounded by a per-side uint128 pot; reject any leaf that couldn't fit, so the uint128 cap
        // math below can't be wrapped by an over-large `amount` into paying out the full uint256 value.
        if (amount > type(uint128).max) revert CapExceeded();

        // per-side conservation cap — the fuse. Never pay out more than this coin/side/epoch actually holds.
        Pot storage p = pot[coin][epoch];
        if (side == Side.Traders) {
            uint128 c = claimedTraders[coin][epoch] + uint128(amount);
            if (c > p.traderPot) revert CapExceeded();
            claimedTraders[coin][epoch] = c;
        } else {
            uint128 c = claimedHolders[coin][epoch] + uint128(amount);
            if (c > p.holderPot) revert CapExceeded();
            claimedHolders[coin][epoch] = c;
        }

        leafClaimed[leaf] = true; // set before transfer (reentrancy)
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert PayFail();
        emit Claimed(epoch, coin, msg.sender, side, amount);
    }

    // ─────────────────────────────────────────────────────────────── sweep ──
    /// @notice After the challenge window, forward the unclaimed remainder (both sides) of a (coin, epoch)
    /// into that coin's Bond Bounty buy-wall — dead rewards become permanent price floor for the same
    /// community. Closes the claim headroom atomically (sets claimed = pot) so no post-sweep claim can pass
    /// the cap. Reuses the router's audited floor→Bond plumbing so this contract stays decoupled from
    /// CurvePool/Bond internals. Permissionless; funds can only ever go to the coin's own floor.
    function sweep(uint256 epoch, address coin) external nonReentrant {
        EpochRoot storage er = epochRoot[epoch];
        if (er.root == bytes32(0)) revert NoRoot();
        if (er.vetoed) revert Vetoed();
        if (block.timestamp < er.postedAt + challengeWindow) revert TooEarly();
        if (swept[coin][epoch]) revert AlreadyClaimed();
        swept[coin][epoch] = true;

        Pot storage p = pot[coin][epoch];
        uint256 remT = p.traderPot - claimedTraders[coin][epoch];
        uint256 remH = p.holderPot - claimedHolders[coin][epoch];
        // close the headroom so a late claim can never pass the cap after sweep
        claimedTraders[coin][epoch] = p.traderPot;
        claimedHolders[coin][epoch] = p.holderPot;

        uint256 rem = remT + remH;
        if (rem > 0) {
            IPadRouterFloor(router).donateFloor{value: rem}(coin);
        }
        emit Swept(epoch, coin, remT, remH);
    }

    // ───────────────────────────────────────────────────────────── admin ──
    function setPoster(address p) external onlyOwner {
        if (p == address(0)) revert ZeroAddr();
        poster = p;
        emit PosterSet(p);
    }

    function setGuardian(address g) external onlyOwner {
        if (g == address(0)) revert ZeroAddr();
        guardian = g;
        emit GuardianSet(g);
    }

    function setFinalityDelay(uint64 d) external onlyOwner {
        finalityDelay = d;
    }

    function setChallengeWindow(uint64 w) external onlyOwner {
        challengeWindow = w;
    }

    /// @notice Ownership gates roles/timing only — never custody (funds move solely by capped Merkle claim or
    /// by sweep-to-floor). Renounce stays available via Ownable; there is no owner path to user ETH.
    receive() external payable {
        if (msg.sender != router) revert OnlyRouter(); // only the router funds this vault
    }
}
