// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";

/// @title RobinLpVault — "provide liquidity, earn fees" for a graduated pad pool (simple, no lock)
/// @notice Anyone deposits BOTH sides (ETH + the pad token) into ONE shared full-range position and earns their
/// pro-rata slice of the real Uniswap v4 swap fees. This is the users' OWN liquidity — withdrawable at will,
/// entirely separate from the protocol's permanently-LOCKED LP (LockVault) and the floor/ambush walls.
///
/// Design (deliberately simple — the risky parts of the old FloorCoop are gone):
///   • no zap/swap and no TWAP oracle — depositors bring both sides, so there is no slippage/impact surface,
///   • no lock tiers / boosts / early-exit penalties — it's their money, in and out,
///   • fees are collected SEPARATELY and never compounded into principal, so each unit of liquidity is fungible
///     and a depositor's share == their liquidity. A MasterChef-style accumulator streams fees per unit.
/// Position management lives in this contract's own `unlock` callback via ADD / REMOVE / COLLECT; principal is
/// only ever removed on the owner's own withdraw().
contract RobinLpVault is IUnlockCallback, ReentrancyGuard {
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;

    enum Op {
        ADD,
        REMOVE,
        COLLECT
    }

    uint256 internal constant ACC_PRECISION = 1e18;

    IPoolManager public immutable poolManager;
    IStateView public immutable stateView;
    Currency public immutable currency0; // ETH
    Currency public immutable currency1; // token
    address public immutable token;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;
    int24 public immutable tickLower; // full range
    int24 public immutable tickUpper;

    uint128 public totalLiquidity;
    mapping(address => uint128) public liquidityOf;

    // MasterChef-style fee streaming (fees collected separately from principal → each liq unit is fungible)
    uint256 public accFee0PerLiq; // ETH fees per unit liquidity, scaled by ACC_PRECISION
    uint256 public accFee1PerLiq; // token fees per unit liquidity
    uint256 public feeReserve0; // ETH fees physically held on this contract awaiting claims (NOT refundable deposit)
    uint256 public feeReserve1; // token fees physically held on this contract awaiting claims
    mapping(address => uint256) public debt0;
    mapping(address => uint256) public debt1;
    mapping(address => uint256) public pending0;
    mapping(address => uint256) public pending1;

    // transient add-context (single unlock, synchronous)
    address private _who;
    uint256 private _ethIn;
    uint256 private _tokIn;
    uint128 private _liqArg;

    event Deposited(address indexed who, uint128 liquidity, uint256 ethUsed, uint256 tokenUsed);
    event Withdrawn(address indexed who, uint128 liquidity, uint256 ethOut, uint256 tokenOut);
    event Claimed(address indexed who, uint256 eth, uint256 token);

    error NotPoolManager();
    error ZeroAddress();
    error ZeroLiquidity();
    error Insufficient();

    constructor(
        address poolManager_,
        address stateView_,
        Currency currency0_,
        Currency currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        IHooks hooks_
    ) {
        if (poolManager_ == address(0) || stateView_ == address(0)) revert ZeroAddress();
        poolManager = IPoolManager(poolManager_);
        stateView = IStateView(stateView_);
        currency0 = currency0_;
        currency1 = currency1_;
        token = Currency.unwrap(currency1_);
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;
        tickLower = TickMath.minUsableTick(tickSpacing_);
        tickUpper = TickMath.maxUsableTick(tickSpacing_);
    }

    // ── views ────────────────────────────────────────────────────────────────────

    /// @notice Fees currently claimable by `who` (ETH, token), including un-harvested pool fees.
    function claimable(address who) external view returns (uint256 eth, uint256 tok) {
        uint256 a0 = accFee0PerLiq;
        uint256 a1 = accFee1PerLiq;
        // NOTE: excludes fees still sitting in the pool position (harvested on the next state-changing call).
        uint128 liq = liquidityOf[who];
        eth = pending0[who] + (uint256(liq) * a0) / ACC_PRECISION - debt0[who];
        tok = pending1[who] + (uint256(liq) * a1) / ACC_PRECISION - debt1[who];
    }

    // ── deposit / withdraw / claim ────────────────────────────────────────────────

    /// @notice Provide liquidity with ETH (msg.value) + up to `tokenMax` token. The vault adds as much as both
    /// sides allow at the current price, credits you the liquidity, and refunds any unused ETH/token. You must
    /// have approved this vault for `tokenMax` of the token.
    function deposit(uint256 tokenMax) external payable nonReentrant returns (uint128 minted) {
        if (msg.value == 0 || tokenMax == 0) revert ZeroLiquidity();
        _harvest();
        _settlePending(msg.sender);

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenMax);
        _who = msg.sender;
        _ethIn = msg.value;
        _tokIn = tokenMax;
        minted = abi.decode(poolManager.unlock(abi.encode(Op.ADD)), (uint128));
        if (minted == 0) revert ZeroLiquidity();

        liquidityOf[msg.sender] += minted;
        totalLiquidity += minted;
        _resetDebt(msg.sender);

        // refund any unused ETH / token the mint didn't consume (excluding the fee reserve, which backs claims)
        uint256 ethBack = address(this).balance - feeReserve0;
        if (ethBack > 0) _payEth(msg.sender, ethBack);
        uint256 tokBack = IERC20(token).balanceOf(address(this)) - feeReserve1;
        if (tokBack > 0) IERC20(token).safeTransfer(msg.sender, tokBack);
        _who = address(0);
        _ethIn = 0;
        _tokIn = 0;
    }

    /// @notice Withdraw `liquidity` of your own position, returning the underlying ETH + token at the current price.
    function withdraw(uint128 liquidity) external nonReentrant returns (uint256 ethOut, uint256 tokenOut) {
        if (liquidity == 0) revert ZeroLiquidity();
        if (liquidity > liquidityOf[msg.sender]) revert Insufficient();
        _harvest();
        _settlePending(msg.sender);

        liquidityOf[msg.sender] -= liquidity;
        totalLiquidity -= liquidity;
        _resetDebt(msg.sender);

        _who = msg.sender;
        _liqArg = liquidity;
        bytes memory ret = poolManager.unlock(abi.encode(Op.REMOVE));
        (ethOut, tokenOut) = abi.decode(ret, (uint256, uint256));
        _who = address(0);
        _liqArg = 0;
        emit Withdrawn(msg.sender, liquidity, ethOut, tokenOut);
    }

    /// @notice Claim accrued fees (ETH + token) without touching your liquidity.
    function claim() external nonReentrant returns (uint256 eth, uint256 tok) {
        _harvest();
        _settlePending(msg.sender);
        eth = pending0[msg.sender];
        tok = pending1[msg.sender];
        pending0[msg.sender] = 0;
        pending1[msg.sender] = 0;
        if (tok > 0) { feeReserve1 -= tok; IERC20(token).safeTransfer(msg.sender, tok); }
        if (eth > 0) { feeReserve0 -= eth; _payEth(msg.sender, eth); }
        emit Claimed(msg.sender, eth, tok);
    }

    // ── unlock callback ────────────────────────────────────────────────────────────

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Op op = abi.decode(data, (Op));
        if (op == Op.ADD) return abi.encode(_add());
        if (op == Op.REMOVE) return _remove();
        _collect();
        return "";
    }

    function _add() internal returns (uint128 L) {
        (uint160 sp,,,) = stateView.getSlot0(_poolId());
        L = LiquidityAmounts.getLiquidityForAmounts(
            sp, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), _ethIn, _tokIn
        );
        if (L == 0) return 0;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(uint256(L)), salt: bytes32(0)}),
            ""
        );
        _settleOwed(currency0, delta.amount0());
        _settleOwed(currency1, delta.amount1());
        emit Deposited(_who, L, _ethIn, _tokIn);
    }

    function _remove() internal returns (bytes memory) {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: -int256(uint256(_liqArg)), salt: bytes32(0)}),
            ""
        );
        uint256 e;
        uint256 t;
        if (delta.amount0() > 0) { e = uint256(uint128(delta.amount0())); poolManager.take(currency0, _who, e); }
        if (delta.amount1() > 0) { t = uint256(uint128(delta.amount1())); poolManager.take(currency1, _who, t); }
        return abi.encode(e, t);
    }

    /// @dev Zero-liquidity poke realizes accrued pool fees as a positive delta; book them to the accumulator.
    function _collect() internal {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        uint128 tl = totalLiquidity;
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        // tl > 0 always here (COLLECT only runs from _harvest, which no-ops when totalLiquidity == 0)
        if (a0 > 0) {
            uint256 f = uint256(uint128(a0));
            poolManager.take(currency0, address(this), f);
            accFee0PerLiq += (f * ACC_PRECISION) / tl;
            feeReserve0 += f;
        }
        if (a1 > 0) {
            uint256 f = uint256(uint128(a1));
            poolManager.take(currency1, address(this), f);
            accFee1PerLiq += (f * ACC_PRECISION) / tl;
            feeReserve1 += f;
        }
    }

    // ── internals ──────────────────────────────────────────────────────────────────

    function _harvest() internal {
        if (totalLiquidity == 0) return; // nothing to poke yet (first depositor)
        poolManager.unlock(abi.encode(Op.COLLECT));
    }

    /// @dev Move a user's newly-accrued fee share into their pending books (call after _harvest, before debt reset).
    function _settlePending(address who) internal {
        uint128 liq = liquidityOf[who];
        if (liq == 0) return;
        pending0[who] += (uint256(liq) * accFee0PerLiq) / ACC_PRECISION - debt0[who];
        pending1[who] += (uint256(liq) * accFee1PerLiq) / ACC_PRECISION - debt1[who];
        _resetDebt(who);
    }

    function _resetDebt(address who) internal {
        uint128 liq = liquidityOf[who];
        debt0[who] = (uint256(liq) * accFee0PerLiq) / ACC_PRECISION;
        debt1[who] = (uint256(liq) * accFee1PerLiq) / ACC_PRECISION;
    }

    function _settleOwed(Currency currency, int128 amt) internal {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            if (currency.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), owed);
                poolManager.settle();
            }
        } else if (amt > 0) {
            poolManager.take(currency, address(this), uint256(uint128(amt)));
        }
    }

    function _payEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "eth");
    }

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
    }

    function _poolId() internal view returns (PoolId) {
        return _poolKey().toId();
    }

    receive() external payable {} // transient ETH during deposit/withdraw settle
}
