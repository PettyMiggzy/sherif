// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRobinHookView {
    function poolConfigs(bytes32 poolId)
        external
        view
        returns (address splitter, address quoteAsset, bool tokenIsToken0, uint16 buyTaxBps, uint16 sellTaxBps, bool active, address locker);
    function blockOpenSqrtPrice(bytes32 poolId) external view returns (uint160);
}

/// @notice Sells the launch tokens the main pad's LP position earns as fees.
///
/// Every sell into a launch pool pays its 1% LP fee in the launch token. On
/// the main pad the locker sends those tokens here instead of burning them,
/// and this contract sells them to anyone for USDG at `DISCOUNT_BPS` (10%)
/// under the pool's price. The USDG goes straight to the platform treasury.
/// So the platform never holds launch tokens and never sells into the pool.
///
/// No owner and no withdraw: tokens leave only through `buy`, paid in full.
///
/// The price is the pool's own. To stop someone pushing it down and buying
/// cheap in the same transaction, a sale uses the HIGHER of the live price
/// and the price the pool opened the block at (RobinHook.blockOpenSqrtPrice),
/// so moving the price down within a block never lowers what the desk charges.
contract RobinFeeDesk is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint16 public constant DISCOUNT_BPS = 1_000; // 10% under the pool's price
    uint16 internal constant BPS = 10_000;
    // Every launch pool's fee and spacing (RobinPortal / PadPortal).
    uint24 public constant POOL_FEE = 10_000;
    int24 public constant TICK_SPACING = 200;

    address public immutable poolManager;
    address public immutable hook;
    address public immutable quoteAsset;
    address public immutable treasury;

    error ZeroAddress();
    error UnknownLaunch();
    error NothingForSale();
    error ZeroAmount();
    error Slippage();

    event Sold(address indexed token, address indexed buyer, address indexed to, uint256 tokens, uint256 quotePaid);

    constructor(address poolManager_, address hook_, address quoteAsset_, address treasury_) {
        if (poolManager_ == address(0) || hook_ == address(0) || quoteAsset_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        poolManager = poolManager_;
        hook = hook_;
        quoteAsset = quoteAsset_;
        treasury = treasury_;
    }

    /// @notice Launch tokens for sale.
    function inventory(address token) public view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice What `quoteIn` buys right now: `tokensOut`, capped at the
    /// inventory, and `quotePaid`, which is less than `quoteIn` when the cap
    /// applies, and `available`, the inventory.
    function quote(address token, uint256 quoteIn)
        public
        view
        returns (uint256 tokensOut, uint256 quotePaid, uint256 available)
    {
        (uint160 sqrtPriceX96, bool tokenIsToken0) = _price(token); // first: rejects anything that isn't a launch
        available = inventory(token);
        uint256 atDiscount = _tokensFor(quoteIn, sqrtPriceX96, tokenIsToken0);
        if (atDiscount <= available) return (atDiscount, quoteIn, available);
        // Not enough for sale: everything that's left, at the same price.
        tokensOut = available;
        quotePaid = atDiscount == 0 ? 0 : FullMath.mulDivRoundingUp(quoteIn, available, atDiscount);
    }

    /// @notice What buying the whole inventory costs.
    function quoteAll(address token) external view returns (uint256 tokens, uint256 quoteCost) {
        (uint160 sqrtPriceX96, bool tokenIsToken0) = _price(token);
        tokens = inventory(token);
        if (tokens == 0) return (0, 0);
        quoteCost = _quoteFor(tokens, sqrtPriceX96, tokenIsToken0);
    }

    /// @notice Buys launch tokens with up to `quoteIn` of the quote asset
    /// (approve this contract first). Pays only for what's available; reverts
    /// if that's under `minTokensOut`. The payment goes to the treasury.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, address to)
        external
        nonReentrant
        returns (uint256 tokensOut, uint256 quotePaid)
    {
        if (quoteIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        (tokensOut, quotePaid,) = quote(token, quoteIn);
        if (tokensOut == 0) revert NothingForSale();
        if (tokensOut < minTokensOut) revert Slippage();
        if (quotePaid == 0) revert ZeroAmount();
        IERC20(quoteAsset).safeTransferFrom(msg.sender, treasury, quotePaid);
        IERC20(token).safeTransfer(to, tokensOut);
        emit Sold(token, msg.sender, to, tokensOut, quotePaid);
    }

    /// @dev The launch's pool price to sell at: the higher (for the token) of
    /// the live price and the block's opening price.
    function _price(address token) internal view returns (uint160 sqrtPriceX96, bool tokenIsToken0) {
        if (token == quoteAsset || token == address(0)) revert UnknownLaunch();
        tokenIsToken0 = token < quoteAsset;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : quoteAsset),
            currency1: Currency.wrap(tokenIsToken0 ? quoteAsset : token),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        bytes32 id = PoolId.unwrap(key.toId());
        (,,,,, bool active,) = IRobinHookView(hook).poolConfigs(id);
        if (!active) revert UnknownLaunch();
        (uint160 live,,,) = IPoolManager(poolManager).getSlot0(PoolId.wrap(id));
        uint160 open = IRobinHookView(hook).blockOpenSqrtPrice(id);
        // token0: price of the token = (sqrtP)^2, higher sqrtP is dearer.
        // token1: price of the token = 1/(sqrtP)^2, lower sqrtP is dearer.
        if (tokenIsToken0) sqrtPriceX96 = live > open ? live : open;
        else sqrtPriceX96 = live < open ? live : open;
    }

    /// @dev Tokens for `quoteIn` at (1 - DISCOUNT) of the pool price, rounded down.
    function _tokensFor(uint256 quoteIn, uint160 sqrtPriceX96, bool tokenIsToken0) internal pure returns (uint256) {
        uint256 full = tokenIsToken0
            // token0 per quote(token1) = 2^192 / sqrtP^2
            ? FullMath.mulDiv(FullMath.mulDiv(quoteIn, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96)
            // token1 per quote(token0) = sqrtP^2 / 2^192
            : FullMath.mulDiv(FullMath.mulDiv(quoteIn, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96);
        return FullMath.mulDiv(full, BPS, BPS - DISCOUNT_BPS);
    }

    /// @dev Quote for `tokens` at (1 - DISCOUNT) of the pool price, rounded up.
    function _quoteFor(uint256 tokens, uint160 sqrtPriceX96, bool tokenIsToken0) internal pure returns (uint256) {
        uint256 full = tokenIsToken0
            ? FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(tokens, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96)
            : FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(tokens, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96);
        return FullMath.mulDivRoundingUp(full, BPS - DISCOUNT_BPS, BPS);
    }
}
