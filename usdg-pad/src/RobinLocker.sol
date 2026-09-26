// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRobinSplitter} from "./interfaces/IRobinSplitter.sol";

/// @notice Holds a launch's LP position forever. Deliberately the contract
/// that CREATES the position (via `seedLiquidity`, called once by the
/// Portal right after transferring in the launch's full token supply)
/// rather than one that receives it after the fact — in Uniswap v4 a
/// position is owned by whichever address actually called
/// `modifyLiquidity`, so if the Portal created the position itself, the
/// locker could never reach it. No owner, no withdraw function, no admin of
/// any kind after seeding — anyone can permissionlessly harvest trading
/// fees, split the same way as everything else on Robin Labs Pad.
contract RobinLocker is IUnlockCallback {
    using SafeERC20 for IERC20;

    /// @dev LP fees collected on the launch-token side are routed here
    /// instead of the splitter (audit finding L-6: without this, the
    /// platform's cut of the splitter's revenue accumulates launch tokens
    /// in the treasury, which is supposed to only ever hold quote assets).
    /// A burn address, not a rescue — nobody, including the platform,
    /// profits from token-side LP fees; only quote-side fees are revenue.
    address public constant TOKEN_FEE_SINK = 0x000000000000000000000000000000000000dEaD;

    address public immutable poolManager;
    address public immutable splitter;
    address public immutable portal; // the only address allowed to call seedLiquidity, and only once
    PoolKey public poolKey;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    bool public immutable tokenIsToken0;

    bool public seeded;

    error NotPoolManager();
    error NotPortal();
    error AlreadySeeded();
    error NotSeededYet();
    error NothingToHarvest();

    event Seeded(uint128 liquidity, uint256 amount0, uint256 amount1);
    event FeesHarvested(uint256 amount0, uint256 amount1, address indexed caller);

    modifier onlyPoolManager() {
        if (msg.sender != poolManager) revert NotPoolManager();
        _;
    }

    constructor(
        address poolManager_,
        address splitter_,
        address portal_,
        PoolKey memory poolKey_,
        int24 tickLower_,
        int24 tickUpper_,
        bool tokenIsToken0_
    ) {
        poolManager = poolManager_;
        splitter = splitter_;
        portal = portal_;
        poolKey = poolKey_;
        tickLower = tickLower_;
        tickUpper = tickUpper_;
        tokenIsToken0 = tokenIsToken0_;
    }

    /// @notice Called once by the Portal, after it has transferred the
    /// launch's full token supply to this contract. Creates the
    /// single-sided concentrated position (pure launch token, resting above
    /// or below the opening price depending on token/quote ordering — see
    /// RobinPortal._seedLaunchPool), owned by this locker from the moment
    /// it exists. No quote asset is ever required to seed it.
    function seedLiquidity(uint128 liquidity) external {
        if (msg.sender != portal) revert NotPortal();
        if (seeded) revert AlreadySeeded();
        seeded = true;
        bytes memory result = IPoolManager(poolManager).unlock(abi.encode(uint8(0), liquidity));
        (uint256 amount0, uint256 amount1) = abi.decode(result, (uint256, uint256));
        emit Seeded(liquidity, amount0, amount1);
    }

    /// @notice Collects this position's accrued fees (a zero-liquidity-delta
    /// modifyLiquidity call, the standard v4 pattern for fee collection)
    /// and routes them to the splitter. Callable by anyone.
    function harvestFees() external {
        if (!seeded) revert NotSeededYet();
        bytes memory result = IPoolManager(poolManager).unlock(abi.encode(uint8(1), uint128(0)));
        (uint256 amount0, uint256 amount1) = abi.decode(result, (uint256, uint256));
        if (amount0 == 0 && amount1 == 0) revert NothingToHarvest();
        emit FeesHarvested(amount0, amount1, msg.sender);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 action, uint128 liquidity) = abi.decode(data, (uint8, uint128));

        int256 liquidityDelta = action == 0 ? int256(uint256(liquidity)) : int256(0);
        (BalanceDelta delta,) = IPoolManager(poolManager).modifyLiquidity(
            poolKey,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        if (action == 0) {
            // Seeding: delta is negative on both sides (we owe the pool).
            uint256 owed0 = delta.amount0() < 0 ? uint256(uint128(-delta.amount0())) : 0;
            uint256 owed1 = delta.amount1() < 0 ? uint256(uint128(-delta.amount1())) : 0;
            if (owed0 > 0) {
                IPoolManager(poolManager).sync(poolKey.currency0);
                IERC20(Currency.unwrap(poolKey.currency0)).safeTransfer(poolManager, owed0);
                IPoolManager(poolManager).settle();
            }
            if (owed1 > 0) {
                IPoolManager(poolManager).sync(poolKey.currency1);
                IERC20(Currency.unwrap(poolKey.currency1)).safeTransfer(poolManager, owed1);
                IPoolManager(poolManager).settle();
            }
            return abi.encode(owed0, owed1);
        } else {
            // Harvesting: delta is positive on both sides (fees owed to us).
            uint256 amount0 = delta.amount0() > 0 ? uint256(int256(delta.amount0())) : 0;
            uint256 amount1 = delta.amount1() > 0 ? uint256(int256(delta.amount1())) : 0;
            if (amount0 > 0) _payout(poolKey.currency0, amount0, tokenIsToken0);
            if (amount1 > 0) _payout(poolKey.currency1, amount1, !tokenIsToken0);
            return abi.encode(amount0, amount1);
        }
    }

    /// @dev Quote-side LP fees are real revenue and flow through the same
    /// splitter as everything else. Launch-token-side LP fees go to
    /// `TOKEN_FEE_SINK` instead (audit finding L-6) — neither the creator
    /// nor the platform should be able to accumulate a claimable pile of
    /// the launch's own token through the platform's own fee-harvesting
    /// path; that's a soft-rug shape no different from H-1's.
    function _payout(Currency currency, uint256 amount, bool isLaunchToken) internal {
        address asset = Currency.unwrap(currency);
        if (isLaunchToken) {
            IPoolManager(poolManager).take(currency, TOKEN_FEE_SINK, amount);
        } else {
            IPoolManager(poolManager).take(currency, splitter, amount);
            IRobinSplitter(splitter).depositRevenue(asset, amount);
        }
    }

    // Deliberately no other function. No withdraw, no rescue, no way to
    // modify the position, no admin function of any kind.
}
