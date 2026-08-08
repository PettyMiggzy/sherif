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
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";

import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";
import {IPositionManagerMinimal} from "../interfaces/IPositionManagerMinimal.sol";
import {IPermit2Minimal} from "../interfaces/IPermit2Minimal.sol";

interface ICurveFactoryCallback {
    function onGraduated(uint256 lpTokenId, Currency c0, Currency c1, address staking, uint16 stakingEthShareBps)
        external;
}

interface IStakingFund {
    function fundTokenPushed(uint8 side, address asset) external returns (uint256);
}

/// @title RobinCurveV4 — a free, single-sided bonding curve on Uniswap V4, per pad
/// @notice The token seeds its OWN liquidity as one token-only (currency1) range `[gradTick, startTick]` with
/// the pool initialized at `startTick` (the range's upper bound ⇒ 100% token, so NO ETH is ever required).
/// Buyers (`zeroForOne`, ETH-in) walk the tick DOWN, converting token→ETH; ETH accumulates as the raise. When
/// price reaches the ceiling (`gradTick`) the token ladder is exhausted ⇒ `ready()` ⇒ anyone `graduate()`s:
///   • sweep the final LP fees → platform,
///   • pull the raised ETH + unsold tokens out of the curve,
///   • seed a PERMANENT, LOCKED full-range 2-sided LP (raised ETH + matching tokens) whose NFT goes to the
///     LockVault (can never be pulled), its LP fees → platform,
///   • stream the REMAINING unsold tokens into the pad's staking pool (holder rewards).
///
/// The curve position is held via the RAW PoolManager (owner-keyed, no NFT) so it is fully withdrawable at
/// graduation — the LockVault, by design, can never release, which is why the permanent LP is a separate
/// PositionManager NFT. Curve-phase LP fees go ENTIRELY to platform (the locked model). All economic params are
/// stamped IMMUTABLY by the factory from the governed RobinV4FeeConfig — this contract cannot self-set fees.
contract RobinCurveV4 is IUnlockCallback, ReentrancyGuard {
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;

    enum Op {
        SEED,
        COLLECT,
        GRADUATE_PULL
    }

    uint48 internal constant MAX_UINT48 = type(uint48).max;

    IPoolManager public immutable poolManager;
    IPositionManagerMinimal public immutable positionManager;
    IPermit2Minimal public immutable permit2;
    IStateView public immutable stateView;
    address public immutable lockVault;
    address public immutable factory;
    IFeeWalletRegistry public immutable feeRegistry;

    // pool (stored as components; PoolKey rebuilt in memory)
    Currency public immutable currency0; // ETH (address 0)
    Currency public immutable currency1; // token
    address public immutable token; // = Currency.unwrap(currency1)
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;

    int24 public immutable startTick; // launch price (curve top; pure-token boundary)
    int24 public immutable gradTick; // ceiling (lower); buys stop here
    uint16 public immutable stakingEthShareBps; // snapshot → carried to the graduated lock

    bool public seeded;
    bool public graduated;
    uint128 public curveL; // liquidity minted at seed (removed whole at graduation)
    address public staking; // the pad's DualStaking pool — set once, platform-gated

    event Seeded(uint128 liquidity, uint256 tokens);
    event CurveFeesCollected(uint256 eth, uint256 tokenFees);
    event StakingSet(address staking);
    event Graduated(uint256 lpTokenId, uint256 raisedEth, uint256 toStaking);
    event StakingFunded(uint256 amount);

    error NotPoolManager();
    error NotFactory();
    error NotPlatform();
    error ZeroAddress();
    error AlreadySeeded();
    error NotSeeded();
    error AlreadyGraduated();
    error AlreadySet();
    error NotReady();
    error EmptyRaise();
    error BadLiquidity();

    constructor(
        address poolManager_,
        address positionManager_,
        address permit2_,
        address stateView_,
        address lockVault_,
        address factory_,
        address feeRegistry_,
        Currency currency0_,
        Currency currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        address hooks_,
        int24 startTick_,
        int24 gradTick_,
        uint16 stakingEthShareBps_
    ) {
        if (
            poolManager_ == address(0) || positionManager_ == address(0) || permit2_ == address(0)
                || stateView_ == address(0) || lockVault_ == address(0) || factory_ == address(0)
                || feeRegistry_ == address(0)
        ) revert ZeroAddress();
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManagerMinimal(positionManager_);
        permit2 = IPermit2Minimal(permit2_);
        stateView = IStateView(stateView_);
        lockVault = lockVault_;
        factory = factory_;
        feeRegistry = IFeeWalletRegistry(feeRegistry_);
        currency0 = currency0_;
        currency1 = currency1_;
        token = Currency.unwrap(currency1_);
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = IHooks(hooks_);
        startTick = startTick_;
        gradTick = gradTick_;
        stakingEthShareBps = stakingEthShareBps_;
    }

    // ── seed ────────────────────────────────────────────────────────────────────

    /// @notice Seed the single-sided token-only curve. Factory-only, one-shot. The factory has already
    /// transferred the curve tokens to this contract; all of them go into the `[gradTick, startTick]` range.
    function seed() external nonReentrant {
        if (msg.sender != factory) revert NotFactory();
        if (seeded) revert AlreadySeeded();
        seeded = true;
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert BadLiquidity();
        poolManager.unlock(abi.encode(Op.SEED, amount));
    }

    // ── live LP-fee sweep (curve phase) ───────────────────────────────────────────

    /// @notice Sweep the curve position's accrued LP fees to the platform. Permissionless; principal untouched.
    /// Per the locked model, ALL curve-phase LP fees → platform.
    function collectFees() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        poolManager.unlock(abi.encode(Op.COLLECT, uint256(0)));
    }

    // ── graduation ────────────────────────────────────────────────────────────────

    function ready() public view returns (bool) {
        if (!seeded || graduated) return false;
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        return tick <= gradTick; // token=currency1: buyers drove the tick down to the ceiling
    }

    /// @notice Graduate at the ceiling: sweep fees→platform, pull raise+unsold, seed the permanent LOCKED
    /// 2-sided LP, route leftover tokens→staking. Permissionless, atomic where it must be, unbrickable.
    function graduate() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        // ready + anti-grief: spot must sit AT the honest ceiling (within one spacing), never shoved far below
        // into empty space — otherwise the permanent LP would seed at a manipulated price. Self-heals via arb.
        if (tick > gradTick || tick < gradTick - tickSpacing) revert NotReady();
        graduated = true; // CEI: flip before any external interaction

        // 1) pull funds inside our own unlock: final fee sweep → platform, then curve principal → this contract
        poolManager.unlock(abi.encode(Op.GRADUATE_PULL, uint256(0)));

        // 2) now this contract holds the raised ETH (native) + the unsold tokens
        uint256 raisedEth = address(this).balance;
        uint256 tokenPool = IERC20(token).balanceOf(address(this));
        if (raisedEth == 0) revert EmptyRaise();

        // 3) seed the PERMANENT LOCKED full-range 2-sided LP (NFT → LockVault). The ETH leg binds, so the
        //    surplus tokens stay here for staking.
        uint256 lpTokenId = _mintPermanentLp(raisedEth, tokenPool);

        // 4) register the lock through the factory (LockVault's sole registrar) — carries the immutable slice
        ICurveFactoryCallback(factory).onGraduated(lpTokenId, currency0, currency1, staking, stakingEthShareBps);

        // 5) stream the leftover unsold tokens → staking (non-bricking; flushStaking() finishes if unwired)
        uint256 toStaking = IERC20(token).balanceOf(address(this));
        _fundStaking(toStaking);

        // 6) sweep any ETH dust → platform
        uint256 dust = address(this).balance;
        if (dust > 0) _payEth(feeRegistry.platformFeeWallet(), dust);

        emit Graduated(lpTokenId, raisedEth, toStaking);
    }

    /// @notice Finish staking funding if the pool wasn't wired/listed at graduation. Permissionless.
    function flushStaking() external nonReentrant {
        if (!graduated) revert NotReady();
        address s = staking;
        if (s == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(s, bal);
        IStakingFund(s).fundTokenPushed(uint8(0), token); // Side.TOKEN; credits balanceOf - accountedReserve
        emit StakingFunded(bal);
    }

    /// @notice Wire the pad's staking pool exactly once, by the platform (deployed after launch).
    function setStaking(address s) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        if (staking != address(0)) revert AlreadySet();
        if (s == address(0)) revert ZeroAddress();
        staking = s;
        emit StakingSet(s);
    }

    // ── unlock callback ─────────────────────────────────────────────────────────

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Op op,) = abi.decode(data, (Op, uint256));
        if (op == Op.SEED) {
            (, uint256 amount) = abi.decode(data, (Op, uint256));
            _seed(amount);
        } else if (op == Op.COLLECT) {
            _collect();
        } else {
            _graduatePull();
        }
        return "";
    }

    function _seed(uint256 amount) internal {
        uint160 sLower = TickMath.getSqrtPriceAtTick(gradTick);
        uint160 sUpper = TickMath.getSqrtPriceAtTick(startTick);
        uint128 L = LiquidityAmounts.getLiquidityForAmount1(sLower, sUpper, amount);
        if (L == 0) revert BadLiquidity();
        curveL = L;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: gradTick, tickUpper: startTick, liquidityDelta: int256(uint256(L)), salt: bytes32(0)}),
            ""
        );
        // pure currency1 (token) position: amount0 should be 0, amount1 negative (we owe token)
        _resolve(currency0, delta.amount0());
        _resolve(currency1, delta.amount1());
        emit Seeded(L, amount);
    }

    function _collect() internal {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _poolKey(),
            ModifyLiquidityParams({tickLower: gradTick, tickUpper: startTick, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        address plat = feeRegistry.platformFeeWallet();
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 > 0) poolManager.take(currency0, plat, uint256(uint128(a0)));
        if (a1 > 0) poolManager.take(currency1, plat, uint256(uint128(a1)));
        emit CurveFeesCollected(a0 > 0 ? uint256(uint128(a0)) : 0, a1 > 0 ? uint256(uint128(a1)) : 0);
    }

    function _graduatePull() internal {
        PoolKey memory key = _poolKey();
        // (a) final LP-fee sweep → platform (so the last batch honors the platform-all rule)
        (BalanceDelta fees,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: gradTick, tickUpper: startTick, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        address plat = feeRegistry.platformFeeWallet();
        if (fees.amount0() > 0) poolManager.take(currency0, plat, uint256(uint128(fees.amount0())));
        if (fees.amount1() > 0) poolManager.take(currency1, plat, uint256(uint128(fees.amount1())));

        // (b) remove the whole curve principal → this contract (raised ETH + unsold tokens)
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: gradTick, tickUpper: startTick, liquidityDelta: -int256(uint256(curveL)), salt: bytes32(0)}),
            ""
        );
        if (d.amount0() > 0) poolManager.take(currency0, address(this), uint256(uint128(d.amount0())));
        if (d.amount1() > 0) poolManager.take(currency1, address(this), uint256(uint128(d.amount1())));
    }

    function _mintPermanentLp(uint256 ethAmt, uint256 tokAmt) internal returns (uint256 tokenId) {
        PoolKey memory key = _poolKey();
        int24 tl = TickMath.minUsableTick(tickSpacing);
        int24 tu = TickMath.maxUsableTick(tickSpacing);
        (uint160 sp,,,) = stateView.getSlot0(_poolId());
        uint128 L = LiquidityAmounts.getLiquidityForAmounts(
            sp, TickMath.getSqrtPriceAtTick(tl), TickMath.getSqrtPriceAtTick(tu), ethAmt, tokAmt
        );
        if (L == 0) revert BadLiquidity();

        IERC20(token).forceApprove(address(permit2), tokAmt);
        permit2.approve(token, address(positionManager), uint160(tokAmt), MAX_UINT48);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, tl, tu, uint256(L), uint128(ethAmt), uint128(tokAmt), lockVault, bytes(""));
        params[1] = abi.encode(currency0, currency1); // settle both (this contract pays)
        params[2] = abi.encode(currency0, address(this)); // sweep native dust back

        uint256 before = positionManager.nextTokenId();
        positionManager.modifyLiquidities{value: ethAmt}(abi.encode(actions, params), block.timestamp);
        tokenId = before;

        permit2.approve(token, address(positionManager), 0, 0);
        IERC20(token).forceApprove(address(permit2), 0);
    }

    function _fundStaking(uint256 amount) internal {
        address s = staking;
        if (s == address(0) || amount == 0) return; // parks on this contract; flushStaking() completes later
        IERC20(token).safeTransfer(s, amount);
        // if the token isn't listed as a TOKEN-side reward yet, this reverts — caught so the LP lock stays final;
        // the tokens are already in the pool and a later flushStaking() credits them via balanceOf-accountedReserve.
        try IStakingFund(s).fundTokenPushed(uint8(0), token) {
            emit StakingFunded(amount);
        } catch {}
    }

    /// @dev Settle what we owe (negative delta). At seed only currency1 is owed; currency0 should be 0.
    function _resolve(Currency currency, int128 amt) internal {
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

    receive() external payable {} // holds the raised ETH transiently at graduation
}
