// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";
import {IPositionManagerMinimal as IPositionManager} from "../interfaces/IPositionManagerMinimal.sol";

/// @title LockVault
/// @notice Holds every launch's seed-LP position NFT PERMANENTLY. The lock is structural,
/// not a flag: this contract exposes NO `decreaseLiquidity`, `burn`, `transfer`, or `approve`
/// selector, and it accepts NFTs ONLY from the canonical PositionManager (that acceptance IS
/// the lock). The single outward path is `collectFees`, encoded as exactly a
/// `DECREASE_LIQUIDITY(tokenId, 0, …)` fee-poke plus `TAKE_PAIR` to THIS vault — never a
/// caller-supplied recipient, never a nonzero liquidity decrease. Collected fees are then
/// split creator/platform and paid accrue-and-pull.
contract LockVault is IERC721Receiver, ReentrancyGuard {
    using CurrencyLibrary for Currency;

    uint16 public constant BASIS_POINTS = 10_000;
    uint16 public constant MIN_CREATOR_FEE_BPS = 100; // 1%
    uint16 public constant MAX_CREATOR_FEE_BPS = 1_000; // 10%

    IPositionManager public immutable positionManager;
    IFeeWalletRegistry public immutable feeRegistry; // platform treasury = single timelocked source
    address public immutable initializer; // bootstrap deployer; may set `factory` exactly once
    address public factory; // set once at bootstrap, then permanently frozen (effectively immutable)

    struct Lock {
        bool registered;
        uint16 creatorFeeBps;
        address creator;
        Currency currency0;
        Currency currency1;
    }

    mapping(uint256 tokenId => Lock) public locks;
    // tokenId => currencyIndex => owed
    mapping(uint256 => mapping(uint256 => uint256)) public creatorOwed;
    mapping(uint256 => mapping(uint256 => uint256)) public platformOwed;

    event LaunchRegistered(uint256 indexed tokenId, address indexed creator, uint16 creatorFeeBps);
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event CreatorClaimed(uint256 indexed tokenId, uint256 currencyIndex, address to, uint256 amount);
    event PlatformClaimed(uint256 indexed tokenId, uint256 currencyIndex, address to, uint256 amount);

    error NotFactory();
    error NotPositionManager();
    error NotInitializer();
    error FactoryAlreadySet();
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidCreatorFee();
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

    /// @notice Bind the factory exactly once at bootstrap. Breaks the factory↔vault ctor cycle
    /// (the factory ctor needs the vault address; the vault only needs the factory address for the
    /// `registerLaunch` guard). After this one call `factory` is permanently frozen.
    function setFactory(address factory_) external {
        if (msg.sender != initializer) revert NotInitializer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Bind a locked position's creator/fee/currencies. Called by the factory in the
    /// same tx that mints the seed LP to this vault, before any swap. One-shot per tokenId.
    function registerLaunch(
        uint256 tokenId,
        address creator,
        uint16 creatorFeeBps,
        Currency currency0,
        Currency currency1
    ) external {
        if (msg.sender != factory) revert NotFactory();
        if (creator == address(0)) revert ZeroAddress();
        if (creatorFeeBps < MIN_CREATOR_FEE_BPS || creatorFeeBps > MAX_CREATOR_FEE_BPS) revert InvalidCreatorFee();
        if (locks[tokenId].registered) revert AlreadyRegistered();

        locks[tokenId] = Lock({
            registered: true,
            creatorFeeBps: creatorFeeBps,
            creator: creator,
            currency0: currency0,
            currency1: currency1
        });
        emit LaunchRegistered(tokenId, creator, creatorFeeBps);
    }

    /// @notice Collect the locked position's accrued LP fees (a zero-liquidity decrease poke)
    /// into this vault, then book the creator/platform split. Permissionless. The ONLY code
    /// path that touches the position, and it can only ever pass a zero decrease and take to
    /// `address(this)` — both hardcoded below, never caller-supplied.
    function collectFees(uint256 tokenId) external nonReentrant {
        Lock storage lk = locks[tokenId];
        if (!lk.registered) revert NotRegistered();

        (uint256 before0, uint256 before1) = _balances(lk.currency0, lk.currency1);

        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        // DECREASE_LIQUIDITY: liquidity == 0 => pure fee poke. amountMins 0 (we take everything owed).
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        // TAKE_PAIR: recipient hardcoded to this vault — NEVER caller-supplied.
        params[1] = abi.encode(lk.currency0, lk.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        (uint256 after0, uint256 after1) = _balances(lk.currency0, lk.currency1);
        uint256 got0 = after0 - before0;
        uint256 got1 = after1 - before1;

        _book(tokenId, 0, got0, lk.creatorFeeBps);
        _book(tokenId, 1, got1, lk.creatorFeeBps);
        emit FeesCollected(tokenId, got0, got1);
    }

    function _book(uint256 tokenId, uint256 idx, uint256 amount, uint16 creatorFeeBps) internal {
        if (amount == 0) return;
        uint256 cCut = (amount * creatorFeeBps) / BASIS_POINTS;
        creatorOwed[tokenId][idx] += cCut;
        platformOwed[tokenId][idx] += amount - cCut; // remainder to platform; subtraction conserves dust
    }

    function claimCreator(uint256 tokenId, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        Lock storage lk = locks[tokenId];
        if (!lk.registered) revert NotRegistered();
        amount = creatorOwed[tokenId][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        creatorOwed[tokenId][currencyIndex] = 0;
        address to = lk.creator;
        _payout(currencyIndex == 0 ? lk.currency0 : lk.currency1, to, amount);
        emit CreatorClaimed(tokenId, currencyIndex, to, amount);
    }

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
