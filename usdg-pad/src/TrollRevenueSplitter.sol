// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITrollSplitter} from "./interfaces/ITrollSplitter.sol";

/// @notice Splits every dollar of revenue a launch generates — swap tax
/// flushed from the shared hook, and LP fees harvested from the launch's own
/// TrollLocker — between the platform treasury and the creator. On Troll
/// Pad's own original pad: 10% to the platform, 90% to the creator. On a
/// TrollPadFactory white-label pad: 15/85 instead — the extra 5% covers
/// hosting the white-label frontend, since that's a real cost only
/// white-label pads create. Flat, no further subdivision.
///
/// Both sides pull. Neither `depositRevenue` nor either claim function ever
/// pushes a transfer to a third party mid-deposit: crediting a balance here
/// can never revert because of who the recipient happens to be, so a
/// blocklisted treasury or a broken creator address can only ever block its
/// own claim — never the other side's, and never the swap or harvest that
/// generated the revenue in the first place (see TrollHook's audit fix,
/// H-2).
contract TrollRevenueSplitter is ITrollSplitter {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAIN_PAD_PLATFORM_SHARE_BPS = 1_000; // 10%
    uint256 public constant WHITE_LABEL_PLATFORM_SHARE_BPS = 1_500; // 15% — covers hosting the white-label frontend

    address public creator;
    address public pendingCreator;
    address public immutable treasury; // Troll Pad's shared plain USDC treasury — see TrollTreasury.sol
    address public immutable portal; // the only address allowed to authorize sources, until locked
    bool public immutable isMainPad; // see TrollPortal.isMainPad — decides the split ratio above

    /// @dev Only these addresses may deposit revenue into this splitter —
    /// the Portal authorizes this launch's shared hook and its own
    /// TrollLocker right after deploying them, in the same transaction the
    /// launch is created, then calls `lockSources` so the set can never grow
    /// again afterward.
    mapping(address => bool) public isAuthorizedSource;
    bool public sourcesLocked;

    mapping(address => uint256) public creditedToCreator; // per quote asset
    mapping(address => uint256) public creditedToPlatform; // per quote asset

    error NotAuthorized();
    error NothingToClaim();
    error SourcesLocked();
    error ZeroAddress();
    error InvalidRecipient();

    event RevenueReceived(address indexed quoteAsset, uint256 total, uint256 platformCut, uint256 creatorCut);
    event CreatorClaimed(address indexed to, address indexed quoteAsset, uint256 amount);
    event PlatformClaimed(address indexed quoteAsset, uint256 amount, address indexed caller);
    event SourceAuthorized(address indexed source);
    event SourcesLockedEvent();
    event CreatorTransferStarted(address indexed from, address indexed to);
    event CreatorTransferred(address indexed from, address indexed to);

    constructor(address creator_, address treasury_, address portal_, bool isMainPad_) {
        if (creator_ == address(0) || treasury_ == address(0) || portal_ == address(0)) revert ZeroAddress();
        creator = creator_;
        treasury = treasury_;
        portal = portal_;
        isMainPad = isMainPad_;
    }

    /// @notice Authorizes a new revenue source. Callable only by the Portal,
    /// only before `lockSources` — used to authorize both the shared hook
    /// (swap tax) and this launch's own TrollLocker (harvested LP fees), in
    /// the same transaction the launch is created.
    function authorizeSource(address source) external {
        if (msg.sender != portal) revert NotAuthorized();
        if (sourcesLocked) revert SourcesLocked();
        isAuthorizedSource[source] = true;
        emit SourceAuthorized(source);
    }

    /// @notice Closes the source set forever. Called once by the Portal at
    /// the end of `createLaunch`, after authorizing this launch's hook and
    /// locker — no other address, including a future portal upgrade, can
    /// ever be added as a revenue source afterward.
    function lockSources() external {
        if (msg.sender != portal) revert NotAuthorized();
        sourcesLocked = true;
        emit SourcesLockedEvent();
    }

    /// @notice Called by the hook or this launch's locker once `amount` of
    /// `quoteAsset` has already been transferred to this contract. Credits
    /// both sides' ledgers; pushes nothing.
    function depositRevenue(address quoteAsset, uint256 amount) external override {
        if (!isAuthorizedSource[msg.sender]) revert NotAuthorized();
        if (amount == 0) return;
        _credit(quoteAsset, amount);
    }

    /// @notice Credits any `asset` this contract holds beyond what its
    /// ledgers already owe — a direct transfer by mistake, a donation —
    /// through the same platform/creator split. Anyone may call. Without
    /// it, such funds were stuck forever (2026-09-24 audit,
    /// splitter-treasury-3).
    function sweepSurplus(address asset) external {
        uint256 owed = creditedToCreator[asset] + creditedToPlatform[asset];
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal <= owed) revert NothingToClaim();
        _credit(asset, bal - owed);
    }

    function _credit(address quoteAsset, uint256 amount) internal {
        uint256 platformShareBps = isMainPad ? MAIN_PAD_PLATFORM_SHARE_BPS : WHITE_LABEL_PLATFORM_SHARE_BPS;
        uint256 platformCut = (amount * platformShareBps) / BPS_DENOMINATOR;
        uint256 creatorCut = amount - platformCut;

        creditedToPlatform[quoteAsset] += platformCut;
        creditedToCreator[quoteAsset] += creatorCut;

        emit RevenueReceived(quoteAsset, amount, platformCut, creatorCut);
    }

    /// @notice Pays the creator's accrued balance for `quoteAsset` to `to`.
    /// Callable only by the creator, but pays whatever address they name.
    function claim(address to, address quoteAsset) external override {
        if (msg.sender != creator) revert NotAuthorized();
        if (to == address(this) || to == address(0)) revert InvalidRecipient(); // paying itself would zero the credit and strand the funds
        uint256 amount = creditedToCreator[quoteAsset];
        if (amount == 0) revert NothingToClaim();
        creditedToCreator[quoteAsset] = 0;
        IERC20(quoteAsset).safeTransfer(to, amount);
        emit CreatorClaimed(to, quoteAsset, amount);
    }

    /// @notice Pays the platform's accrued balance for `quoteAsset` to the
    /// shared treasury. Callable by anyone — same pull-based reasoning as
    /// `claim`, just with no restriction on who triggers it, since the
    /// destination is fixed and immutable.
    function claimPlatform(address quoteAsset) external override {
        uint256 amount = creditedToPlatform[quoteAsset];
        if (amount == 0) revert NothingToClaim();
        creditedToPlatform[quoteAsset] = 0;
        IERC20(quoteAsset).safeTransfer(treasury, amount);
        emit PlatformClaimed(quoteAsset, amount, msg.sender);
    }

    /// @notice Two-step creator handover. The only recovery path for a lost
    /// creator key is the creator rotating it BEFORE it's lost — there is no
    /// admin override, on purpose (see M-4 in the audit: an admin override
    /// here would be a much bigger risk than an unrecoverable lost key).
    function transferCreator(address newCreator) external {
        if (msg.sender != creator) revert NotAuthorized();
        pendingCreator = newCreator;
        emit CreatorTransferStarted(creator, newCreator);
    }

    function acceptCreator() external {
        if (msg.sender != pendingCreator) revert NotAuthorized();
        emit CreatorTransferred(creator, msg.sender);
        creator = msg.sender;
        pendingCreator = address(0);
    }
}
