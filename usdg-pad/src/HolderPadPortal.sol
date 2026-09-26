// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {PadPortal} from "./PadPortal.sol";
import {PadRevenueSplitter} from "./PadRevenueSplitter.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

interface IHolderTokenDeployer {
    function deploy(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        address quoteAsset,
        address poolManager,
        address splitter,
        uint256 holdersSlot
    ) external returns (address);
}

/// @notice A PadPortal whose creators can also give holders a share of the
/// fees. Everything PadPortal does is inherited unchanged: the pad owner's
/// controls, the payouts, `createLaunch` (a plain RobinLaunchToken, exactly
/// as today) and the launch mechanics. It adds `createLaunchWithHolders`:
/// the token is a RobinHolderToken, and the splitter gets one extra payout
/// wallet, the token itself, for `holdersBps` of the creator's share.
/// Holders claim their USDC from the token. The split is locked at launch
/// like every other slice: the token has no way to move its slot.
///
/// Built by HolderPadTemplate through RobinPadFactory's template slot. The
/// holder token is created by a separate deployer contract only to keep
/// this contract under the 24 KB size limit.
contract HolderPadPortal is PadPortal {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    address public immutable holderTokenDeployer;

    /// @notice Holders' share of the creator's share, per token (0 for plain launches).
    mapping(address => uint16) public holdersBpsForToken;

    event HolderShare(address indexed token, uint256 holdersSlot, uint16 holdersBps);

    constructor(
        address poolManager_,
        address hook_,
        address treasury_,
        address quoteAsset_,
        address splitterImplementation_,
        uint16 platformShareBps_,
        address padOwner_,
        PadSettings memory settings_,
        address holderTokenDeployer_
    )
        PadPortal(
            poolManager_, hook_, treasury_, quoteAsset_, splitterImplementation_, platformShareBps_, padOwner_, settings_
        )
    {
        if (holderTokenDeployer_ == address(0)) revert ZeroAddress();
        holderTokenDeployer = holderTokenDeployer_;
    }

    /// @notice Like createLaunch, plus `holdersBps` of the creator's share
    /// for everyone holding the token. `alloc` may have up to 4 wallets
    /// here (the holders take the 5th slot), and `alloc` plus `holdersBps`
    /// must add up to 100%. `holdersBps` must be above 0.
    function createLaunchWithHolders(
        CreateLaunchParams calldata p,
        FeeAllocation calldata alloc,
        uint16 holdersBps,
        uint16 maxOwnerShareBps,
        uint256 maxLaunchFee
    ) external returns (address token, address locker) {
        PadSettings memory s = settings;
        if (s.launchesPaused) revert LaunchesPaused();
        if (s.inviteOnly && !approvedCreator[msg.sender]) revert NotApproved();
        if (s.padOwnerShareBps > maxOwnerShareBps || s.launchFee > maxLaunchFee) revert TermsChanged();
        if (p.buyTaxBps > s.maxTaxBps || p.sellTaxBps > s.maxTaxBps) revert TaxTooHigh();
        if (p.buyTaxBps < s.minTaxBps || p.sellTaxBps < s.minTaxBps) revert TaxTooLow();
        if (p.startingMarketCapQuote < s.minStartingMarketCapQuote || p.startingMarketCapQuote > s.maxStartingMarketCapQuote) {
            revert StartingMcOutOfRange();
        }

        if (s.launchFee > 0) {
            uint256 platformCut = (s.launchFee * platformShareBps) / BPS_DENOMINATOR;
            IERC20(quoteAsset).safeTransferFrom(msg.sender, treasury, platformCut);
            IERC20(quoteAsset).safeTransferFrom(msg.sender, padOwner, s.launchFee - platformCut);
        }

        // The splitter first, so the token can name it; the token takes the
        // last payout slot. The splitter checks the whole allocation (at most
        // 5 wallets, none 0%, adding up to 100%).
        uint256 slot = alloc.recipients.length;
        if (alloc.recipientBps.length != slot) revert PadRevenueSplitter.InvalidAllocation();
        address splitter = Clones.clone(splitterImplementation);
        token = IHolderTokenDeployer(holderTokenDeployer).deploy(
            p.name, p.symbol, TOTAL_SUPPLY, quoteAsset, poolManager, splitter, slot
        );
        address[] memory recipients = new address[](slot + 1);
        uint16[] memory recipientBps = new uint16[](slot + 1);
        for (uint256 i; i < slot; i++) {
            recipients[i] = alloc.recipients[i];
            recipientBps[i] = alloc.recipientBps[i];
        }
        recipients[slot] = token;
        recipientBps[slot] = holdersBps;
        PadRevenueSplitter(splitter).initialize(
            PadRevenueSplitter.InitParams({
                creator: msg.sender,
                treasury: treasury,
                poolManager: poolManager,
                token: token,
                quoteAsset: quoteAsset,
                hook: hook,
                poolFee: POOL_FEE,
                tickSpacing: TICK_SPACING,
                platformShareBps: platformShareBps,
                padOwnerShareBps: s.padOwnerShareBps,
                recipients: recipients,
                recipientBps: recipientBps,
                buybackBps: alloc.buybackBps
            })
        );

        SeedResult memory r = _seedLaunchPool(token, splitter, p.startingMarketCapQuote, p.buyTaxBps, p.sellTaxBps);
        locker = r.locker;

        lockerForToken[token] = locker;
        splitterForToken[token] = splitter;
        holdersBpsForToken[token] = holdersBps;
        allLaunches.push(token);

        emit LaunchCreated(
            token,
            msg.sender,
            locker,
            splitter,
            PoolId.unwrap(r.key.toId()),
            quoteAsset,
            r.tokenIsToken0,
            p.buyTaxBps,
            p.sellTaxBps,
            r.tickLower,
            r.tickUpper,
            r.initSqrtPriceX96,
            p.name,
            p.symbol
        );
        emit LaunchTerms(token, s.padOwnerShareBps, s.launchFee);
        emit HolderShare(token, slot, holdersBps);
    }
}
