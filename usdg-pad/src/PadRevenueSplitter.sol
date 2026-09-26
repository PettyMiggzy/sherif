// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRobinSplitter} from "./interfaces/IRobinSplitter.sol";

interface IPadOwnerSource {
    function padOwner() external view returns (address);
}

/// @notice Revenue splitter for one launch on a PadPortal: Robin Labs Pad itself
/// (a "house pad") or any white-label pad. Every deposit (the hook's tax
/// flush, the locker's USDC-side LP fees) is split, then held until
/// claimed. Nothing is ever pushed out on deposit, so a blocklisted
/// recipient can only block its own claim, never trading, the hook's flush
/// or anyone else's money.
///
/// The split, all fixed when the token launches:
/// 1. Robin Labs platform: `platformShareBps` (10% on house pads, 15% on
///    white-label pads);
/// 2. the pad owner: `padOwnerShareBps`, whatever that pad charged;
/// 3. the creator's share, everything left, divided by the creator's own
///    fee allocation: up to 5 payout wallets plus an optional buyback &
///    burn bucket, with the percentages adding up to 100%.
///
/// Buyback & burn: the bucket's USDC buys the launch's own token on its pool
/// and sends it to the dead address. Only the creator can trigger it, with a
/// minimum-tokens-out guard, so a bot can't trigger it at a bad price and
/// sandwich it.
///
/// Deployed as EIP-1167 clones of one implementation (initialized in the
/// portal's createLaunch transaction), which keeps PadPortal under the
/// contract size limit. The token itself is never a clone.
contract PadRevenueSplitter is IRobinSplitter, IUnlockCallback {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_RECIPIENTS = 5;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    struct InitParams {
        address creator;
        address treasury;
        address poolManager;
        address token;
        address quoteAsset;
        address hook;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 platformShareBps;
        uint16 padOwnerShareBps;
        address[] recipients;
        uint16[] recipientBps; // of the creator's share
        uint16 buybackBps; // of the creator's share; recipientBps + buybackBps == 100%
    }

    bool public initialized;
    address public portal; // the PadPortal that launched this token; source of the pad owner's address
    address public treasury;
    address public poolManager;
    address public token;
    address public quoteAsset;
    bool public tokenIsToken0;
    uint16 public platformShareBps;
    uint16 public padOwnerShareBps;
    uint16 public buybackBps;
    PoolKey internal _key;

    address public creator; // runs the buyback; transferable in two steps
    address public pendingCreator;
    address[] internal _recipients;
    uint16[] internal _recipientBps;
    uint256[] internal _recipientCredit;

    mapping(address => bool) public isAuthorizedSource;
    bool public sourcesLocked;

    uint256 public platformCredit;
    uint256 public padOwnerCredit;
    uint256 public buybackCredit;
    uint256 public totalBuybackSpent; // quote spent on buybacks, ever
    uint256 public totalBurned; // launch tokens bought back and burned, ever
    bool private _buying;

    error AlreadyInitialized();
    error NotAuthorized();
    error NothingToClaim();
    error SourcesLocked();
    error ZeroAddress();
    error InvalidRecipient();
    error InvalidAllocation();
    error ShareTooHigh();
    error WrongAsset();
    error InvalidAmount();
    error Slippage();

    event AllocationSet(address[] recipients, uint16[] recipientBps, uint16 buybackBps);
    event RevenueReceived(
        uint256 total, uint256 platformCut, uint256 padOwnerCut, uint256 buybackCut, uint256 recipientsCut
    );
    event RecipientPaid(uint256 indexed slot, address indexed to, uint256 amount);
    event RecipientChanged(uint256 indexed slot, address indexed from, address indexed to);
    event PadOwnerClaimed(address indexed to, uint256 amount);
    event PlatformClaimed(uint256 amount, address indexed caller);
    event BuybackBurned(uint256 quoteSpent, uint256 tokensBurned);
    event SourceAuthorized(address indexed source);
    event SourcesLockedEvent();
    event CreatorTransferStarted(address indexed from, address indexed to);
    event CreatorTransferred(address indexed from, address indexed to);

    /// @dev The implementation itself can never be initialized; only clones can.
    constructor() {
        initialized = true;
    }

    /// @notice Called once by the launching portal, in the same transaction
    /// that clones this splitter.
    function initialize(InitParams calldata p) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        if (
            p.creator == address(0) || p.treasury == address(0) || p.poolManager == address(0) || p.token == address(0)
                || p.quoteAsset == address(0) || p.hook == address(0)
        ) revert ZeroAddress();
        if (uint256(p.platformShareBps) + p.padOwnerShareBps > BPS_DENOMINATOR) revert ShareTooHigh();
        uint256 n = p.recipients.length;
        if (n == 0 || n > MAX_RECIPIENTS || n != p.recipientBps.length) revert InvalidAllocation();
        uint256 sum = p.buybackBps;
        for (uint256 i; i < n; i++) {
            if (p.recipients[i] == address(0)) revert ZeroAddress();
            if (p.recipientBps[i] == 0) revert InvalidAllocation();
            sum += p.recipientBps[i];
            _recipients.push(p.recipients[i]);
            _recipientBps.push(p.recipientBps[i]);
            _recipientCredit.push(0);
        }
        if (sum != BPS_DENOMINATOR) revert InvalidAllocation();

        portal = msg.sender;
        creator = p.creator;
        treasury = p.treasury;
        poolManager = p.poolManager;
        token = p.token;
        quoteAsset = p.quoteAsset;
        platformShareBps = p.platformShareBps;
        padOwnerShareBps = p.padOwnerShareBps;
        buybackBps = p.buybackBps;
        bool t0 = p.token < p.quoteAsset;
        tokenIsToken0 = t0;
        _key = PoolKey({
            currency0: Currency.wrap(t0 ? p.token : p.quoteAsset),
            currency1: Currency.wrap(t0 ? p.quoteAsset : p.token),
            fee: p.poolFee,
            tickSpacing: p.tickSpacing,
            hooks: IHooks(p.hook)
        });
        emit AllocationSet(p.recipients, p.recipientBps, p.buybackBps);
    }

    // ---------------------------------------------------------------- deposits

    function authorizeSource(address source) external {
        if (msg.sender != portal) revert NotAuthorized();
        if (sourcesLocked) revert SourcesLocked();
        isAuthorizedSource[source] = true;
        emit SourceAuthorized(source);
    }

    function lockSources() external {
        if (msg.sender != portal) revert NotAuthorized();
        sourcesLocked = true;
        emit SourcesLockedEvent();
    }

    /// @notice Credits `amount` of quote, already transferred in by an
    /// authorized source (the hook or the locker).
    function depositRevenue(address asset, uint256 amount) external override {
        if (!isAuthorizedSource[msg.sender]) revert NotAuthorized();
        if (asset != quoteAsset) revert WrongAsset();
        if (amount == 0) return;
        _credit(amount);
    }

    /// @notice Credits quote sent here directly by mistake, by the normal split.
    function sweepSurplus(address asset) external {
        if (asset != quoteAsset) revert WrongAsset();
        uint256 owed = platformCredit + padOwnerCredit + buybackCredit;
        for (uint256 i; i < _recipientCredit.length; i++) {
            owed += _recipientCredit[i];
        }
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal <= owed) revert NothingToClaim();
        _credit(bal - owed);
    }

    function _credit(uint256 amount) internal {
        uint256 platformCut = (amount * platformShareBps) / BPS_DENOMINATOR;
        uint256 padOwnerCut = (amount * padOwnerShareBps) / BPS_DENOMINATOR;
        uint256 pool = amount - platformCut - padOwnerCut;
        uint256 buybackCut = (pool * buybackBps) / BPS_DENOMINATOR;
        uint256 given = buybackCut;
        for (uint256 i = 1; i < _recipients.length; i++) {
            uint256 c = (pool * _recipientBps[i]) / BPS_DENOMINATOR;
            _recipientCredit[i] += c;
            given += c;
        }
        _recipientCredit[0] += pool - given; // rounding dust goes to the first wallet

        platformCredit += platformCut;
        padOwnerCredit += padOwnerCut;
        buybackCredit += buybackCut;
        emit RevenueReceived(amount, platformCut, padOwnerCut, buybackCut, pool - buybackCut);
    }

    // ------------------------------------------------------------------ payouts

    /// @notice Pays payout wallet `slot` everything it's owed. Anyone may call;
    /// the money only goes to that slot's wallet. Returns 0 if nothing is owed.
    function claimRecipient(uint256 slot) public returns (uint256 amount) {
        amount = _recipientCredit[slot];
        if (amount == 0) return 0;
        _recipientCredit[slot] = 0;
        address to = _recipients[slot];
        IERC20(quoteAsset).safeTransfer(to, amount);
        emit RecipientPaid(slot, to, amount);
    }

    /// @notice Pays every payout wallet. If one wallet can't receive (e.g. it's
    /// blocklisted), use claimRecipient for the others.
    function distribute() external returns (uint256 total) {
        for (uint256 i; i < _recipients.length; i++) {
            total += claimRecipient(i);
        }
    }

    /// @notice IRobinSplitter compatibility: a payout wallet claims what all of
    /// its slots are owed, to any address it chooses.
    function claim(address to, address asset) external override {
        if (asset != quoteAsset) revert WrongAsset();
        if (to == address(this) || to == address(0)) revert InvalidRecipient();
        uint256 amount;
        for (uint256 i; i < _recipients.length; i++) {
            if (_recipients[i] == msg.sender) {
                uint256 c = _recipientCredit[i];
                if (c > 0) {
                    _recipientCredit[i] = 0;
                    amount += c;
                    emit RecipientPaid(i, to, c);
                }
            }
        }
        if (amount == 0) revert NothingToClaim();
        IERC20(asset).safeTransfer(to, amount);
    }

    /// @notice A payout wallet moves its own slot, and whatever it's owed, to
    /// a new address. The percentages never change; nobody else can move it.
    function updateRecipient(uint256 slot, address newRecipient) external {
        if (msg.sender != _recipients[slot]) revert NotAuthorized();
        if (newRecipient == address(0) || newRecipient == address(this)) revert InvalidRecipient();
        _recipients[slot] = newRecipient;
        emit RecipientChanged(slot, msg.sender, newRecipient);
    }

    /// @notice Pays the pad owner's share to the pad's CURRENT owner. Anyone may
    /// call. Returns 0 instead of reverting, so the portal can batch it.
    function claimPadOwner(address asset) external returns (uint256 amount) {
        if (asset != quoteAsset) revert WrongAsset();
        amount = padOwnerCredit;
        if (amount == 0) return 0;
        padOwnerCredit = 0;
        address to = IPadOwnerSource(portal).padOwner();
        IERC20(asset).safeTransfer(to, amount);
        emit PadOwnerClaimed(to, amount);
    }

    /// @notice Pays Robin Labs' share to the treasury. Anyone may call.
    function claimPlatform(address asset) external override {
        if (asset != quoteAsset) revert WrongAsset();
        uint256 amount = platformCredit;
        if (amount == 0) revert NothingToClaim();
        platformCredit = 0;
        IERC20(asset).safeTransfer(treasury, amount);
        emit PlatformClaimed(amount, msg.sender);
    }

    // ---------------------------------------------------------- buyback & burn

    /// @notice Spends `amountIn` of the buyback bucket buying this launch's
    /// token on its pool, and burns every token bought (sends it to DEAD).
    /// Creator only; reverts unless at least `minTokensOut` is bought, so
    /// pass a quote minus your slippage.
    function executeBuyback(uint256 amountIn, uint256 minTokensOut) external returns (uint256 tokensBurned) {
        if (msg.sender != creator) revert NotAuthorized();
        if (amountIn == 0 || amountIn > buybackCredit) revert InvalidAmount();
        _buying = true;
        (uint256 spent, uint256 bought) =
            abi.decode(IPoolManager(poolManager).unlock(abi.encode(amountIn)), (uint256, uint256));
        _buying = false;
        if (bought < minTokensOut) revert Slippage();
        buybackCredit -= spent; // spent <= amountIn <= buybackCredit, checked in the callback
        totalBuybackSpent += spent;
        totalBurned += bought;
        tokensBurned = bought;
        emit BuybackBurned(spent, bought);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager || !_buying) revert NotAuthorized();
        uint256 amountIn = abi.decode(data, (uint256));
        bool zeroForOne = !tokenIsToken0; // paying quote, receiving the token
        BalanceDelta d = IPoolManager(poolManager).swap(
            _key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 quoteDelta = tokenIsToken0 ? d.amount1() : d.amount0();
        int128 tokenDelta = tokenIsToken0 ? d.amount0() : d.amount1();
        uint256 owed = quoteDelta < 0 ? uint256(uint128(-quoteDelta)) : 0;
        // Never spend more than was taken out of the bucket.
        if (owed > amountIn) revert InvalidAmount();
        uint256 bought = tokenDelta > 0 ? uint256(uint128(tokenDelta)) : 0;

        Currency quote = Currency.wrap(quoteAsset);
        IPoolManager(poolManager).sync(quote);
        IERC20(quoteAsset).safeTransfer(poolManager, owed);
        IPoolManager(poolManager).settle();
        if (bought > 0) IPoolManager(poolManager).take(Currency.wrap(token), DEAD, bought);
        return abi.encode(owed, bought);
    }

    // -------------------------------------------------------------- creator role

    function transferCreator(address newCreator) external {
        if (msg.sender != creator) revert NotAuthorized();
        pendingCreator = newCreator;
        emit CreatorTransferStarted(creator, newCreator);
    }

    function acceptCreator() external {
        if (msg.sender != pendingCreator || msg.sender == address(0)) revert NotAuthorized();
        emit CreatorTransferred(creator, msg.sender);
        creator = msg.sender;
        pendingCreator = address(0);
    }

    // -------------------------------------------------------------------- views

    function allocation() external view returns (address[] memory recipients, uint16[] memory bps, uint16 buyback) {
        return (_recipients, _recipientBps, buybackBps);
    }

    function recipientCredits() external view returns (uint256[] memory) {
        return _recipientCredit;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    /// @notice What `account` can claim across all its payout slots.
    function creditOf(address account) external view returns (uint256 amount) {
        for (uint256 i; i < _recipients.length; i++) {
            if (_recipients[i] == account) amount += _recipientCredit[i];
        }
    }

    /// @notice Compatibility views, all in quote.
    function creditedToCreator(address asset) external view returns (uint256 amount) {
        if (asset != quoteAsset) return 0;
        for (uint256 i; i < _recipientCredit.length; i++) {
            amount += _recipientCredit[i];
        }
    }

    function creditedToPlatform(address asset) external view returns (uint256) {
        return asset == quoteAsset ? platformCredit : 0;
    }

    function creditedToPadOwner(address asset) external view returns (uint256) {
        return asset == quoteAsset ? padOwnerCredit : 0;
    }
}
