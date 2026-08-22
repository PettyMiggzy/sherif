// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ICurvePadFactoryV4, LaunchConfig} from "../interfaces/ICurvePadFactoryV4.sol";
import {PadValuation} from "../core/PadValuation.sol";
import {RobinV4FeeConfig} from "../core/RobinV4FeeConfig.sol";
import {IFeeWalletRegistry} from "../interfaces/IRobinInterfaces.sol";
import {ArrowDistributor} from "./ArrowDistributor.sol";

interface IRobinCurveGraduate {
    function graduate() external;
}

/// @title ArrowLauncher — a one-tx migration launch: buy the whole curve, graduate, airdrop to the dev's holders
/// @notice "Arrow" is the migration launcher. A dev arrives with ETH and a committed merkle root of their existing
/// holders (address+amount). In ONE transaction this contract:
///   1. takes a flat `PLATFORM_FEE` (0.5 ETH) off the top → the platform (the platform's cut; the platform takes ETH),
///   2. launches a fresh Robin V4 curve (`factory.launch` — deploys token+hook+curve, seeds the single-sided curve),
///   3. buys out the ENTIRE curve in one price-limited swap that lands spot EXACTLY at the graduation ceiling,
///   4. graduates it → the permanent LP is minted and LOCKED (LockVault); the pad is live and un-ruggable,
///   5. hands the bought supply to a fresh no-withdraw `ArrowDistributor`, committed to the dev's merkle root,
///   6. refunds the dev any ETH the buyout didn't spend.
/// The dev ends holding ZERO tokens — every bought token is claimable only by the committed holder set. "No dev
/// wallet holds the bag, clean bubble map." The dev's ETH-side economics are the ordinary creator stream (sell tax +
/// the graduation creator share, claimable from the curve) — never a token bag.
///
/// This is a COMPOSER over public interfaces only: it calls `factory.launch`, the public PoolManager swap path, and
/// the permissionless `curve.graduate()`. It modifies nothing in the audited curve/hook/factory. The three legs
/// (launch unlock, swap unlock, graduate unlock) are SEQUENTIAL top-level lock cycles — never nested — so v4's
/// no-nested-unlock rule is respected and each leg's own `nonReentrant` is untouched.
contract ArrowLauncher is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice Flat platform cut taken off the top of every Arrow launch, in ETH. The platform takes ETH only.
    uint256 public constant PLATFORM_FEE = 0.5 ether;
    /// @dev Over-request the buyout by this margin so the price-limited swap always REACHES the ceiling (the exact
    /// `_absorbableIn` is a floor, a couple wei short of gradSqrt, which would leave graduate() reverting NotReady).
    /// The price limit caps execution AT gradSqrt, so the margin never overshoots — it only guarantees arrival. The
    /// hook taxes the requested input, so a small margin means a negligible over-tax (margin·buyTax); the unspent
    /// remainder is refunded to the dev. 1% clears any geometry's flooring gap.
    uint256 internal constant BUYOUT_MARGIN_BPS = 100; // +1%
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PIPS = 1_000_000;

    ICurvePadFactoryV4 public immutable factory;
    IPoolManager public immutable poolManager;
    IFeeWalletRegistry public immutable feeRegistry; // timelocked platform sink (resolve live)

    bool private _expectingUnlock; // gates unlockCallback to a swap this contract itself initiated

    event ArrowLaunched(
        address indexed dev,
        address indexed token,
        address curve,
        address distributor,
        uint256 platformFee,
        uint256 buyoutSpent,
        uint256 supplyAirdropped,
        bytes32 merkleRoot
    );

    error ZeroAddress();
    error EmptyRoot();
    error BelowPlatformFee();
    error UnderfundedBuyout();
    error NotPoolManager();
    error UnexpectedUnlock();
    error ZeroBought();
    error NotReady();
    error EthSendFailed();

    constructor(address factory_, address feeRegistry_) {
        if (factory_ == address(0) || feeRegistry_ == address(0)) revert ZeroAddress();
        factory = ICurvePadFactoryV4(factory_);
        poolManager = IPoolManager(ICurvePadFactoryV4(factory_).poolManager());
        feeRegistry = IFeeWalletRegistry(feeRegistry_);
    }

    /// @notice Launch a migration pad, buy out the whole curve, graduate, and airdrop the bought supply to the dev's
    /// committed holders — all atomically. `msg.value` must cover the 0.5 ETH platform fee PLUS the full-curve
    /// buyout; any surplus is refunded to the caller. `merkleRoot` commits the (index, account, amount) holder set.
    /// @param cfg the launch config (creator = the dev's own address for the ordinary creator ETH stream)
    /// @param merkleRoot the immutable root of the dev's holder snapshot, handed to the distributor
    function launch(
        LaunchConfig calldata cfg,
        bytes32 tokenSalt,
        bytes32 hookSalt,
        bytes32 curveSalt,
        bytes32 merkleRoot
    ) external payable nonReentrant returns (address token, address curve, address distributor) {
        if (merkleRoot == bytes32(0)) revert EmptyRoot();
        if (msg.value <= PLATFORM_FEE) revert BelowPlatformFee();

        // [audit M1] Snapshot any pre-existing balance (a donation / force-send to the receive() below, or ETH
        // stranded by an earlier launch) so step-7 refunds ONLY this launch's change — never sweeps a stranger's
        // donation to whoever calls next. This singleton must not accrue value to a caller. preBal stays put.
        uint256 preBal = address(this).balance - msg.value;

        // 1) flat platform fee off the top → the platform (ETH only). Sent first; CEI-safe (no state depends on it).
        uint256 budget = msg.value - PLATFORM_FEE;
        _sendEth(feeRegistry.platformFeeWallet(), PLATFORM_FEE);

        // 2) launch the pad (deploys token+hook+curve, inits the pool at startTick, seeds the single-sided curve)
        address hook;
        PoolId poolId;
        (token, hook, curve, poolId) = factory.launch(cfg, tokenSalt, hookSalt, curveSalt);

        // reconstruct the pool key from the SAME feeConfig read the factory just used (same tx ⇒ identical)
        RobinV4FeeConfig.Defaults memory d = RobinV4FeeConfig(factory.feeConfig()).defaults();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: uint24(d.lpFee),
            tickSpacing: cfg.tickSpacing,
            hooks: IHooks(hook)
        });
        // [FDV] resolve exactly as the factory did one call ago: a cfg-chosen start tick overrides the default.
        int24 startTick = PadValuation.startTickOf(cfg.startTickMag, d.startTickMag);
        int24 gradTick = startTick - d.curveWidth;
        uint160 gradSqrt = TickMath.getSqrtPriceAtTick(gradTick);

        // 3) size the FULL buyout: the exact ETH to walk startTick → gradTick (grossed up for lpFee then buyTax),
        //    plus a small margin so the price-limited swap REACHES gradSqrt rather than stopping a couple wei short.
        uint256 amtIn =
            _absorbableIn(TickMath.getSqrtPriceAtTick(startTick), gradSqrt, cfg.curveSupply, d.lpFee, d.buyTaxBps);
        amtIn += Math.mulDiv(amtIn, BUYOUT_MARGIN_BPS, BPS);
        if (amtIn == 0) revert ZeroBought();
        if (budget < amtIn) revert UnderfundedBuyout(); // the dev must fund the whole buyout

        // 4) buy out the curve — one exact-input swap price-limited AT gradSqrt (stops exactly at the ceiling)
        uint256 tokBefore = IERC20(token).balanceOf(address(this));
        _expectingUnlock = true;
        uint256 spent = abi.decode(poolManager.unlock(abi.encode(amtIn, key, gradSqrt)), (uint256));
        _expectingUnlock = false;
        uint256 bought = IERC20(token).balanceOf(address(this)) - tokBefore;
        if (bought == 0) revert ZeroBought();

        // 5) graduate — the buy landed spot exactly at gradSqrt, so ready(); LP is minted + LOCKED. Reverts NotReady
        //    only if the swap somehow fell short (guarded above), never after a real full buyout.
        IRobinCurveGraduate(curve).graduate();

        // 6) hand the bought supply to a fresh no-withdraw distributor committed to the dev's holder root
        distributor = address(new ArrowDistributor(token, merkleRoot));
        IERC20(token).safeTransfer(distributor, bought);

        // 7) refund the dev every ETH the launch didn't spend (unspent buyout budget + the graduation keeper bounty
        //    this contract collected as the caller of graduate()), EXCLUDING any pre-existing balance ([audit M1]).
        //    The dev keeps NO token — only their ETH change.
        uint256 leftover = address(this).balance - preBal;
        if (leftover > 0) _sendEth(msg.sender, leftover);

        emit ArrowLaunched(msg.sender, token, curve, distributor, PLATFORM_FEE, spent, bought, merkleRoot);
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_expectingUnlock) revert UnexpectedUnlock();
        (uint256 amtIn, PoolKey memory key, uint160 gradSqrt) = abi.decode(data, (uint256, PoolKey, uint160));
        BalanceDelta sd = poolManager.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: -int256(amtIn), sqrtPriceLimitX96: gradSqrt}), ""
        );
        uint256 ethOwed = uint256(uint128(-sd.amount0())); // ETH the buyout actually spent (fee + consumed) ≤ amtIn
        uint256 tokenOut = uint256(uint128(sd.amount1())); // whole curve supply, net of the hook skim
        poolManager.settle{value: ethOwed}();
        poolManager.take(key.currency1, address(this), tokenOut);
        return abi.encode(ethOwed);
    }

    /// @dev The largest exact-input BUY this freshly-launched curve absorbs before spot reaches gradSqrt, grossed up
    /// for the two cuts taken off the input first (hook buyTax fee-on-input, then the pool lpFee). Same derivation as
    /// PresaleVault._absorbableIn — the factory has just seeded exactly `curveSupply` as one token-only range
    /// [gradTick, startTick], so L and the amount0 to walk it are exact (floored to a lower bound).
    function _absorbableIn(uint160 startSqrt, uint160 gradSqrt, uint256 curveSupply, uint24 lpFee, uint16 buyTaxBps)
        internal
        pure
        returns (uint256 amtIn)
    {
        uint128 L = LiquidityAmounts.getLiquidityForAmount1(gradSqrt, startSqrt, curveSupply);
        if (L == 0 || lpFee >= PIPS || buyTaxBps >= BPS) return 0;
        amtIn = SqrtPriceMath.getAmount0Delta(gradSqrt, startSqrt, L, false); // ETH into the reserve, round DOWN
        amtIn = Math.mulDiv(amtIn, PIPS, PIPS - lpFee); // gross up the lpFee (pool charges it on the post-skim input)
        amtIn = Math.mulDiv(amtIn, BPS, BPS - buyTaxBps); // gross up the buyTax (hook skims it first, off the request)
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthSendFailed();
    }

    receive() external payable {} // graduation keeper bounty + swap change land here, swept to the dev
}
