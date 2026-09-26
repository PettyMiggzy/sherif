// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PadPortal} from "./PadPortal.sol";
import {PadPortalTemplate} from "./PadPortalTemplate.sol";
import {TrollHook} from "./TrollHook.sol";
import {IPadTemplate, IPadWiring} from "./interfaces/IPadTemplate.sol";

/// @notice "A pad that launches pads." Anyone pays the setup fee and gets
/// their own white-label launchpad (a PadPortal, Troll takes 15%) in the
/// same transaction, wired into the SAME shared TrollHook as Troll Pad. The
/// pad owner runs it: their share of every launch's revenue (up to 85%),
/// a launch fee of up to $1,000, the min and max tax, the minimum starting
/// market cap, pausing new launches and invite-only mode. The factory owner
/// can also open "house pads" (Troll takes 10%). Troll Pad itself is one.
/// See docs/PAD-FACTORY.md.
///
/// The live hook accepts exactly one factory, ever (bootstrapFactory is
/// one-shot), so this contract is permanent once plugged in. To keep room
/// for new kinds of pads (another quote asset, another launch token), the
/// owner can approve pad templates (IPadTemplate): plug-ins the factory
/// deploys pads through, with the same setup fee and Troll share, checking
/// each new pad's wiring before authorizing it on the hook.
///
/// The factory owner keeps three knobs: the setup fee (capped at
/// MAX_SETUP_FEE; a buyer passes the most they'll pay), opening house pads,
/// and approving templates. It has no power over existing pads, launches,
/// tokens or liquidity. Revoking a template only stops new pads from it.
contract TrollPadFactory {
    using SafeERC20 for IERC20;

    address public immutable poolManager;
    address public immutable hook; // shared across every pad (and the main pad)
    address public immutable treasury; // TrollTreasury: receives setup fees and Troll's 15%
    address public immutable quoteAsset; // USDC: every pad's quote asset, and what fees are paid in
    address public immutable splitterImplementation; // every launch's splitter is a clone of this
    /// @notice Template #1, created by this constructor: builds every
    /// `deployPad` / `deployHousePad` pad (a standard PadPortal).
    address public immutable padPortalTemplate;

    uint16 public constant PAD_PLATFORM_SHARE_BPS = 1_500; // Troll's share on white-label pads
    uint16 public constant HOUSE_PLATFORM_SHARE_BPS = 1_000; // Troll's share on house pads (Troll Pad)

    /// @dev Sanity ceiling in quoteAsset raw units: $10,000 in 6-decimal
    /// USDC. Also catches a fee written in the wrong decimals (audit
    /// factory-trust-2).
    uint256 public constant MAX_SETUP_FEE = 10_000e6;

    uint256 public setupFee;
    address public owner;
    address public pendingOwner;

    address[] public allPads;
    mapping(address => bool) public isPad;
    mapping(address => bool) public isHousePad;
    mapping(address => bool) public isApprovedTemplate;
    /// @notice The template each pad was built from (`padPortalTemplate` for a standard pad).
    mapping(address => address) public templateOf;

    error ZeroFee();
    error ZeroAddress();
    error HookMismatch();
    error FeeTooHigh();
    error FeeChanged();
    error NotOwner();
    error TemplateNotApproved();
    error InvalidTemplate();
    error InvalidPortal();

    event PadDeployed(address indexed portal, address indexed owner, string label, uint256 feePaid);
    event HousePadDeployed(address indexed portal, address indexed owner, string label);
    event TemplatePadDeployed(
        address indexed portal, address indexed template, address indexed owner, string label, uint256 feePaid, bool house
    );
    event TemplateApproval(address indexed template, bool approved);
    event SetupFeeChanged(uint256 oldFee, uint256 newFee);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor(
        address poolManager_,
        address hook_,
        address treasury_,
        address quoteAsset_,
        address splitterImplementation_,
        uint256 setupFee_,
        address owner_
    ) {
        if (
            poolManager_ == address(0) || hook_ == address(0) || treasury_ == address(0) || quoteAsset_ == address(0)
                || owner_ == address(0) || splitterImplementation_.code.length == 0
        ) revert ZeroAddress();
        // Everything above is immutable, so a factory wired to a different
        // PoolManager than its hook could never launch a working pad.
        if (TrollHook(hook_).poolManager() != poolManager_) revert HookMismatch();
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        quoteAsset = quoteAsset_;
        splitterImplementation = splitterImplementation_;
        owner = owner_;
        _setSetupFee(setupFee_);
        padPortalTemplate =
            address(new PadPortalTemplate(poolManager_, hook_, treasury_, quoteAsset_, splitterImplementation_));
    }

    /// @notice Pay the setup fee and get your own launchpad. `label` is the
    /// pad's name, informational only (branding lives off-chain).
    /// `maxSetupFee` is the most you agree to pay, normally the fee the site
    /// showed you. You must have approved this factory for the setup fee in
    /// quoteAsset.
    function deployPad(string calldata label, PadPortal.PadSettings calldata settings, uint256 maxSetupFee)
        external
        returns (address portal)
    {
        uint256 fee = setupFee;
        if (fee > maxSetupFee) revert FeeChanged();
        IERC20(quoteAsset).safeTransferFrom(msg.sender, treasury, fee);

        portal = _deploy(PAD_PLATFORM_SHARE_BPS, msg.sender, settings);
        emit PadDeployed(portal, msg.sender, label, fee);
    }

    /// @notice Owner only: open a house pad, where Troll takes 10%. Troll Pad
    /// itself is deployed this way. No setup fee.
    function deployHousePad(string calldata label, address padOwner, PadPortal.PadSettings calldata settings)
        external
        returns (address portal)
    {
        if (msg.sender != owner) revert NotOwner();
        portal = _deploy(HOUSE_PLATFORM_SHARE_BPS, padOwner, settings);
        isHousePad[portal] = true;
        emit HousePadDeployed(portal, padOwner, label);
    }

    /// @notice Pay the setup fee and get a pad built by an approved
    /// template. `config` is that template's settings, ABI-encoded. Same
    /// fee, same guard and the same 15% as `deployPad`.
    function deployPadFromTemplate(address template, string calldata label, bytes calldata config, uint256 maxSetupFee)
        external
        returns (address portal)
    {
        if (!isApprovedTemplate[template]) revert TemplateNotApproved();
        uint256 fee = setupFee;
        if (fee > maxSetupFee) revert FeeChanged();
        IERC20(quoteAsset).safeTransferFrom(msg.sender, treasury, fee);

        portal = _deployFromTemplate(template, PAD_PLATFORM_SHARE_BPS, msg.sender, config);
        emit TemplatePadDeployed(portal, template, msg.sender, label, fee, false);
    }

    /// @notice Owner only: a house pad (Troll takes 10%) built by an
    /// approved template. No setup fee.
    function deployHousePadFromTemplate(address template, string calldata label, address padOwner, bytes calldata config)
        external
        returns (address portal)
    {
        if (msg.sender != owner) revert NotOwner();
        if (!isApprovedTemplate[template]) revert TemplateNotApproved();
        portal = _deployFromTemplate(template, HOUSE_PLATFORM_SHARE_BPS, padOwner, config);
        isHousePad[portal] = true;
        emit TemplatePadDeployed(portal, template, padOwner, label, 0, true);
    }

    function _deploy(uint16 platformShareBps, address padOwner, PadPortal.PadSettings calldata settings)
        internal
        returns (address portal)
    {
        return _deployFromTemplate(padPortalTemplate, platformShareBps, padOwner, abi.encode(settings));
    }

    /// @dev Templates are owner-approved code, but the hook trusts every pad
    /// this factory registers, so check what came back anyway: a fresh
    /// contract on this factory's hook, PoolManager and treasury, charging
    /// Troll's share, owned by the right wallet.
    function _deployFromTemplate(address template, uint16 platformShareBps, address padOwner, bytes memory config)
        internal
        returns (address portal)
    {
        if (padOwner == address(0)) revert ZeroAddress();
        portal = IPadTemplate(template).deployPortal(padOwner, platformShareBps, config);
        if (portal.code.length == 0 || isPad[portal]) revert InvalidPortal();
        IPadWiring p = IPadWiring(portal);
        if (
            p.hook() != hook || p.poolManager() != poolManager || p.treasury() != treasury
                || p.platformShareBps() != platformShareBps || p.padOwner() != padOwner
        ) revert InvalidPortal();
        templateOf[portal] = template;
        TrollHook(hook).authorizePortal(portal);
        isPad[portal] = true;
        allPads.push(portal);
    }

    function padCount() external view returns (uint256) {
        return allPads.length;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Changes the price of new pads. Existing pads are unaffected.
    function setSetupFee(uint256 newFee) external {
        if (msg.sender != owner) revert NotOwner();
        _setSetupFee(newFee);
    }

    function _setSetupFee(uint256 newFee) internal {
        // A $0 fee would make this a free clone factory for spam pads.
        if (newFee == 0) revert ZeroFee();
        if (newFee > MAX_SETUP_FEE) revert FeeTooHigh();
        emit SetupFeeChanged(setupFee, newFee);
        setupFee = newFee;
    }

    /// @notice Approve or revoke a pad template. Revoking only stops new
    /// pads from it; pads it already built keep working.
    function setTemplateApproved(address template, bool approved) external {
        if (msg.sender != owner) revert NotOwner();
        if (approved && template.code.length == 0) revert InvalidTemplate();
        isApprovedTemplate[template] = approved;
        emit TemplateApproval(template, approved);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
