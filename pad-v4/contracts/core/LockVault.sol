// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";
import {IPositionManagerMinimal as IPositionManager} from "../interfaces/IPositionManagerMinimal.sol";

/// @title LockVault
/// @notice Holds every launch's seed-LP position NFT PERMANENTLY. The lock is structural, not a flag:
/// this contract exposes NO `decreaseLiquidity`, `burn`, `transfer`, or `approve` selector, and it
/// accepts NFTs ONLY from the canonical PositionManager (that acceptance IS the lock). The single
/// outward path is `collectFees`, encoded as exactly a `DECREASE_LIQUIDITY(tokenId, 0, …)` fee-poke
/// plus `TAKE_PAIR` to THIS vault — never a caller-supplied recipient, never a nonzero decrease.
///
/// Collected LP fees route by currency, matching the pad's fee model:
///   • currency0 (the QUOTE, accrued from BUYS)  → platform (timelocked treasury)
///   • currency1 (the TOKEN, accrued from SELLS) → the pad's staking recipient (fed to stakers)
/// Both are accrue-and-pull. If a launch has no staking recipient, its token leg falls back to platform.
contract LockVault is IERC721Receiver, ReentrancyGuard {
    using CurrencyLibrary for Currency;

    IPositionManager public immutable positionManager;
    IFeeWalletRegistry public immutable feeRegistry; // platform treasury = single timelocked source
    address public immutable initializer; // bootstrap deployer; may set `factory` exactly once
    address public factory; // set once at bootstrap, then permanently frozen (effectively immutable)

    struct Lock {
        bool registered;
        Currency currency0; // quote
        Currency currency1; // token
        address stakingRecipient; // where the token (sell-side) LP fee goes; 0 => platform
    }

    mapping(uint256 tokenId => Lock) public locks;
    // tokenId => currencyIndex => owed
    mapping(uint256 => mapping(uint256 => uint256)) public platformOwed; // quote leg (buys)
    mapping(uint256 => mapping(uint256 => uint256)) public stakingOwed; // token leg (sells)

    event LaunchRegistered(uint256 indexed tokenId, address indexed stakingRecipient);
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event PlatformClaimed(uint256 indexed tokenId, uint256 currencyIndex, address to, uint256 amount);
    event StakingClaimed(uint256 indexed tokenId, uint256 currencyIndex, address to, uint256 amount);

    error NotFactory();
    error NotPositionManager();
    error NotInitializer();
    error FactoryAlreadySet();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();
    error NothingToClaim();
    error PayoutFailed();

    event FactorySet(address indexed factory);

    constructor(address positionManager_, address feeRegistry_) {
        if (positionManager_ == address(0) || feeRegistry_ == address(0)) revert ZeroAddress();
        positionManager = IPositionManager(positionManager_);
        feeRegistry = IFeeWalletRegistry(feeRegistry_);
        initializer = msg.sender;
    }

    /// @notice Bind the factory exactly once at bootstrap (breaks the factory↔vault ctor cycle).
    function setFactory(address factory_) external {
        if (msg.sender != initializer) revert NotInitializer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Bind a locked position's currencies + staking recipient. Factory-only, one-shot.
    function registerLaunch(uint256 tokenId, Currency currency0, Currency currency1, address stakingRecipient)
        external
    {
        if (msg.sender != factory) revert NotFactory();
        if (locks[tokenId].registered) revert AlreadyRegistered();
        locks[tokenId] =
            Lock({registered: true, currency0: currency0, currency1: currency1, stakingRecipient: stakingRecipient});
        emit LaunchRegistered(tokenId, stakingRecipient);
    }

    /// @notice Collect the locked position's accrued LP fees (a zero-liquidity decrease poke) into this
    /// vault, then book the platform (quote) / staking (token) split. Permissionless. The ONLY code path
    /// that touches the position — it can only ever pass a zero decrease and take to `address(this)`.
    function collectFees(uint256 tokenId) external nonReentrant {
        Lock storage lk = locks[tokenId];
        if (!lk.registered) revert NotRegistered();

        (uint256 before0, uint256 before1) = _balances(lk.currency0, lk.currency1);

        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(lk.currency0, lk.currency1, address(this)); // recipient hardcoded to this vault
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        (uint256 after0, uint256 after1) = _balances(lk.currency0, lk.currency1);
        uint256 got0 = after0 - before0;
        uint256 got1 = after1 - before1;

        if (got0 > 0) platformOwed[tokenId][0] += got0; // quote (buys) → platform
        if (got1 > 0) stakingOwed[tokenId][1] += got1; // token (sells) → staking
        emit FeesCollected(tokenId, got0, got1);
    }

    /// @notice Pull the platform's (quote-leg) LP fees for a launch to the timelocked treasury.
    function claimPlatform(uint256 tokenId, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        Lock storage lk = locks[tokenId];
        if (!lk.registered) revert NotRegistered();
        amount = platformOwed[tokenId][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        platformOwed[tokenId][currencyIndex] = 0;
        address to = feeRegistry.platformFeeWallet();
        _payout(currencyIndex == 0 ? lk.currency0 : lk.currency1, to, amount);
        emit PlatformClaimed(tokenId, currencyIndex, to, amount);
    }

    /// @notice Forward the staking (token-leg) LP fees to the pad's staking recipient (or platform if
    /// none was set). Permissionless — funds always go to the registered recipient, never the caller.
    function claimStaking(uint256 tokenId, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        Lock storage lk = locks[tokenId];
        if (!lk.registered) revert NotRegistered();
        amount = stakingOwed[tokenId][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        stakingOwed[tokenId][currencyIndex] = 0;
        address to = lk.stakingRecipient == address(0) ? feeRegistry.platformFeeWallet() : lk.stakingRecipient;
        _payout(currencyIndex == 0 ? lk.currency0 : lk.currency1, to, amount);
        emit StakingClaimed(tokenId, currencyIndex, to, amount);
    }

    function _balances(Currency c0, Currency c1) internal view returns (uint256 b0, uint256 b1) {
        b0 = c0.balanceOfSelf();
        b1 = c1.balanceOfSelf();
    }

    function _payout(Currency currency, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (currency.isAddressZero()) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert PayoutFailed();
        } else {
            currency.transfer(to, amount);
        }
    }

    /// @dev Accepting the NFT ONLY from the canonical PositionManager IS the lock.
    function onERC721Received(address, address, uint256, bytes calldata) external view override returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev Native fee deliveries from TAKE_PAIR land here.
    receive() external payable {}
}
