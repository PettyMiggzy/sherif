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
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
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
/// price reaches the ceiling (`gradTick`, the range's LOWER bound ⇒ the curve is fully sold), anyone graduate()s.
///
/// A held-back token RESERVE (transferred by the factory AFTER seed, so it is never in the sellable range) funds
/// graduation — because a fully-sold curve holds ~0 token. graduate():
///   • pulls the raised ETH out of the curve (its accrued LP fees accrue to the platform book),
///   • seeds a PERMANENT, LOCKED full-range 2-sided LP from (raised ETH + reserve tokens); its NFT goes to the
///     LockVault (can never be pulled), its LP fees → platform,
///   • streams the LEFTOVER reserve tokens into the pad's staking pool (holder rewards).
///
/// Platform LP fees are accrue-and-pull (`claimPlatform`), never sent inline, so a bad platform wallet can never
/// brick collectFees/graduate. All economic params are stamped IMMUTABLY by the factory from the governed
/// RobinV4FeeConfig — this contract cannot self-set fees.
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
    uint256 internal constant NUDGE_MAX_FRACTION = 100; // the ceiling nudge may spend ≤ 1/100 of the reserve

    IPoolManager public immutable poolManager;
    IPositionManagerMinimal public immutable positionManager;
    IPermit2Minimal public immutable permit2;
    IStateView public immutable stateView;
    address public immutable lockVault;
    address public immutable factory;
    IFeeWalletRegistry public immutable feeRegistry;

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

    // accrue-and-pull platform LP fees (never sent inline → cannot brick collect/graduate)
    uint256 public platformEthOwed;
    uint256 public platformTokenOwed;

    event Seeded(uint128 liquidity, uint256 tokens);
    event CurveFeesAccrued(uint256 eth, uint256 tokenFees);
    event PlatformClaimed(uint256 eth, uint256 tokenAmt, address to);
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
    error NoReserve();
    error BadLiquidity();
    error CeilingNotRestored();
    error InsufficientReserve();

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

    /// @notice Seed the single-sided token-only curve with THIS contract's whole current token balance (the
    /// factory transfers exactly the sellable `curveSupply` before calling, then transfers the graduation reserve
    /// AFTER — so the reserve is never in the sellable range). Factory-only, one-shot.
    function seed() external nonReentrant {
        if (msg.sender != factory) revert NotFactory();
        if (seeded) revert AlreadySeeded();
        seeded = true;
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert BadLiquidity();
        poolManager.unlock(abi.encode(Op.SEED, amount));
    }

    // ── live LP-fee sweep (curve phase) ───────────────────────────────────────────

    /// @notice Realize the curve position's accrued LP fees to this contract's platform book. Permissionless;
    /// principal untouched. Pull with claimPlatform(). Per the locked model, ALL curve-phase LP fees → platform.
    function collectFees() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        poolManager.unlock(abi.encode(Op.COLLECT, uint256(0)));
    }

    /// @notice Forward accrued platform LP fees (+ post-graduation dust) to the platform wallet. Permissionless;
    /// the only sink is the governed wallet. Standalone + retriable, so a bad recipient can never brick the pad.
    function claimPlatform() external nonReentrant {
        uint256 e = platformEthOwed;
        uint256 t = platformTokenOwed;
        if (e == 0 && t == 0) return;
        platformEthOwed = 0;
        platformTokenOwed = 0;
        address plat = feeRegistry.platformFeeWallet();
        if (t > 0) IERC20(token).safeTransfer(plat, t);
        if (e > 0) _payEth(plat, e);
        emit PlatformClaimed(e, t, plat);
    }

    // ── graduation ────────────────────────────────────────────────────────────────

    function ready() public view returns (bool) {
        if (!seeded || graduated) return false;
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        return tick <= gradTick; // curve fully sold (spot at the ceiling, or below it if a buy overshot)
    }

    /// @notice Graduate at the ceiling: pull the raise from the curve, seed the permanent LOCKED 2-sided LP from
    /// (raise + reserve), stream leftover reserve → staking. Permissionless; CEI-ordered; unbrickable.
    function graduate() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        (, int24 tick,,) = stateView.getSlot0(_poolId());
        if (tick > gradTick) revert NotReady(); // curve not fully sold yet
        graduated = true; // CEI: flip before any external interaction

        // 1) pull the raise out of the curve. The unlock FIRST nudges spot back up to the exact ceiling if a buy
        //    (or a griefer's planted liquidity) overshot below it, so the permanent LP always seeds at gradTick —
        //    never a manipulated price. Then it accrues fees and takes the principal to this contract.
        poolManager.unlock(abi.encode(Op.GRADUATE_PULL, uint256(0)));

        // 2) the raise is this contract's ETH minus the platform-owed fee book; the reserve is its token minus
        //    the platform-owed token fees. A fully-sold curve yields ~0 token, so the LP token leg is the RESERVE.
        uint256 raisedEth = address(this).balance - platformEthOwed;
        uint256 tokenReserve = IERC20(token).balanceOf(address(this)) - platformTokenOwed;
        if (raisedEth == 0) revert EmptyRaise();
        if (tokenReserve == 0) revert NoReserve(); // [CRITICAL-1] must have a held-back reserve to pair the LP

        // 3) seed the PERMANENT LOCKED full-range 2-sided LP (NFT → LockVault). The reserve is sized so the ETH
        //    leg binds; the surplus reserve tokens stay here for staking.
        uint256 lpTokenId = _mintPermanentLp(raisedEth, tokenReserve);

        // 4) register the lock through the factory (LockVault's sole registrar) — carries the immutable slice
        ICurveFactoryCallback(factory).onGraduated(lpTokenId, currency0, currency1, staking, stakingEthShareBps);

        // 5) stream the leftover reserve tokens → staking (non-bricking; flushStaking() finishes if unwired)
        uint256 leftoverToken = IERC20(token).balanceOf(address(this)) - platformTokenOwed;
        _fundStaking(leftoverToken);

        // 6) sweep the fee book + any LP dust into the platform book (claimed later, never sent inline here)
        platformEthOwed = address(this).balance;
        emit Graduated(lpTokenId, raisedEth, leftoverToken);
    }

    /// @notice Finish staking funding if the pool wasn't wired/listed at graduation. Permissionless.
    function flushStaking() external nonReentrant {
        if (!graduated) revert NotReady();
        address s = staking;
        if (s == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this)) - platformTokenOwed; // never sweep platform fees
        if (bal > 0) IERC20(token).safeTransfer(s, bal);
        IStakingFund(s).fundTokenPushed(uint8(0), token); // Side.TOKEN; credits balanceOf - accountedReserve
        emit StakingFunded(bal);
    }

    /// @notice Wire the pad's staking pool exactly once, by the platform (deployed after launch).
    function setStaking(address s) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        if (staking != address(0)) revert AlreadySet();
        if (s == address(0) || s.code.length == 0) revert ZeroAddress(); // [LOW-3] must be a contract (the pool)
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
        // pure currency1 (token) position: amount0 == 0, amount1 negative (we owe token) — NO ETH pulled
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
        (uint256 e, uint256 t) = _takeFeesToBook(delta);
        emit CurveFeesAccrued(e, t);
    }

    function _graduatePull() internal {
        PoolKey memory key = _poolKey();

        // (0) anti-grief nudge: if spot overshot BELOW the ceiling (a big buy into the empty zone, or a third
        // party planted liquidity under gradTick to shove it there), sell on-hand token UP to the ceiling limit.
        // In the empty zone this consumes ~0 (no liquidity below gradTick); against any planted liquidity it powers
        // through — bounded by our balance — until spot lands EXACTLY at gradTick, so the permanent LP seeds honest.
        (, int24 curTick,,) = stateView.getSlot0(_poolId());
        if (curTick < gradTick) {
            // Budget the nudge to ≤1% of the reserve ONLY (never the platform fee book — that avoids the
            // underflow at raisedEth/tokenReserve below), and FAIL CLOSED: if it can't restore spot to the
            // exact ceiling (e.g. a griefer planted deep liquidity under gradTick), revert rather than bleed the
            // reserve into their position. In the honest overshoot case the zone below gradTick is empty, so the
            // swap crosses it for ~0 and lands exactly at gradTick.
            uint256 budget = (IERC20(token).balanceOf(address(this)) - platformTokenOwed) / NUDGE_MAX_FRACTION;
            if (budget > 0) {
                BalanceDelta sd = poolManager.swap(
                    key,
                    SwapParams({
                        zeroForOne: false, // token-in → price UP toward the ceiling
                        amountSpecified: -int256(budget),
                        sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(gradTick)
                    }),
                    ""
                );
                _resolve(currency0, sd.amount0()); // take any ETH out
                _resolve(currency1, sd.amount1()); // settle the (tiny) token consumed
            }
            (, int24 nowTick,,) = stateView.getSlot0(_poolId());
            if (nowTick != gradTick) revert CeilingNotRestored(); // never seed the permanent LP at a fake price
        }

        // (a) realize accrued fees → platform book (taken to this contract, accrued, NOT sent to platform inline)
        (BalanceDelta fees,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: gradTick, tickUpper: startTick, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        _takeFeesToBook(fees);

        // (b) remove the whole curve principal → this contract (the raised ETH; token ≈ 0 at the ceiling)
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: gradTick, tickUpper: startTick, liquidityDelta: -int256(uint256(curveL)), salt: bytes32(0)}),
            ""
        );
        if (d.amount0() > 0) poolManager.take(currency0, address(this), uint256(uint128(d.amount0())));
        if (d.amount1() > 0) poolManager.take(currency1, address(this), uint256(uint128(d.amount1())));
    }

    /// @dev Take a fee delta to this contract and accrue it to the platform book.
    function _takeFeesToBook(BalanceDelta delta) internal returns (uint256 e, uint256 t) {
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 > 0) {
            e = uint256(uint128(a0));
            poolManager.take(currency0, address(this), e);
            platformEthOwed += e;
        }
        if (a1 > 0) {
            t = uint256(uint128(a1));
            poolManager.take(currency1, address(this), t);
            platformTokenOwed += t;
        }
    }

    function _mintPermanentLp(uint256 ethAmt, uint256 tokAvail) internal returns (uint256 tokenId) {
        PoolKey memory key = _poolKey();
        int24 tl = TickMath.minUsableTick(tickSpacing);
        int24 tu = TickMath.maxUsableTick(tickSpacing);
        // Spot is guaranteed == gradTick here (the nudge + CeilingNotRestored check), so price at the canonical
        // ceiling. [HIGH-2] Size the LP by the ETH leg so the ENTIRE raise binds into the locked position — never
        // let the token leg bind and leak unbound raise ETH to the platform book. Revert if the reserve can't
        // cover the token side the raise requires (fail closed; the launch-time check makes this unreachable).
        uint160 spGrad = TickMath.getSqrtPriceAtTick(gradTick);
        uint128 L = LiquidityAmounts.getLiquidityForAmount0(spGrad, TickMath.getSqrtPriceAtTick(tu), ethAmt);
        if (L == 0) revert BadLiquidity();
        // the reserve must supply at least L on the token leg, else the token binds and unbound raise ETH leaks
        if (LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tl), spGrad, tokAvail) < L) {
            revert InsufficientReserve();
        }

        IERC20(token).forceApprove(address(permit2), tokAvail);
        permit2.approve(token, address(positionManager), uint160(tokAvail), MAX_UINT48);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        // amount1Max = tokAvail (the mint pulls only what L needs, ≤ tokAvail; the surplus stays for staking)
        params[0] = abi.encode(key, tl, tu, uint256(L), uint128(ethAmt), uint128(tokAvail), lockVault, bytes(""));
        params[1] = abi.encode(currency0, currency1); // settle both (this contract pays)
        params[2] = abi.encode(currency0, address(this)); // sweep the tiny ETH rounding dust back

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
        // if the token isn't listed / this curve isn't a rewarder yet, this reverts — caught so the LP lock stays
        // final; the tokens are already in the pool and a later flushStaking() credits them (balanceOf-accounted).
        try IStakingFund(s).fundTokenPushed(uint8(0), token) {
            emit StakingFunded(amount);
        } catch {}
    }

    /// @dev Settle what we owe (negative delta). At seed only currency1 is owed; currency0 must be 0.
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
