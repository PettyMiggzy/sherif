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
    function onGraduated(uint256 lpTokenId, Currency c0, Currency c1, address staking) external;
}

interface IStakingFund {
    function fundTokenPushed(uint8 side, address asset) external returns (uint256);
}

/// @dev [M-25] The two staking sinks name their TOKEN-side stake asset differently — RobinLockStaking calls it
/// `token()`, DualStaking calls it `tokenAsset()`. `setStaking` probes both so a sink built for another pad can
/// never be wired: `fundTokenPushed` measures the sink's OWN balance, so a foreign sink accepts the graduation
/// reservoir, credits nothing, and returns 0 without reverting.
interface IStakeAssetProbe {
    function token() external view returns (address);
    function tokenAsset() external view returns (address);
}

/// @dev [R3-N2] Shape probe for the one KNOWN token-holding non-pool: the per-pad `RobinTokenTreasury` exposes
/// `token()` == the pad token, so the stake-asset probe alone cannot tell it from a staking pool — and wiring the
/// graduation reservoir through the treasury's 70/30 splitter would silently burn 30% of the dump (the decided
/// model is reservoir → 100% staking). No staking sink exposes `TO_STAKING_BPS()`; its presence marks a splitter.
interface ITreasurySplitProbe {
    function TO_STAKING_BPS() external view returns (uint16);
}

interface IFloorVault {
    function addFloor() external returns (uint128);
}

interface IRobinFeeHookBuffer {
    function claimBuffer(PoolId id) external returns (uint256);
}

/// @dev [M-9] The pad hook's current creator slot. The hook's creator is repointable via a 2-step flow; this
/// contract's was a launch-time immutable with no repoint and no alternate exit, so one pad had two creator
/// addresses that could permanently diverge. `currentCreator()` follows this one.
interface IRobinFeeHookCreator {
    function creatorOf(PoolId id) external view returns (address);
}

/// @title RobinCurveV4 — a free, single-sided bonding curve on Uniswap V4, per pad
/// @notice The token seeds its OWN liquidity as one token-only (currency1) range `[gradTick, startTick]` with
/// the pool initialized at `startTick` (the range's upper bound ⇒ 100% token, so NO ETH is ever required).
/// Buyers (`zeroForOne`, ETH-in) walk the tick DOWN, converting token→ETH; ETH accumulates as the raise. When
/// price reaches the ceiling (`gradTick`, the range's LOWER bound ⇒ the curve is fully sold), anyone graduate()s.
///
/// A held-back token RESERVE (transferred by the factory AFTER seed, so it is never in the sellable range) funds
/// graduation — because a fully-sold curve holds ~0 token. graduate() waterfalls the raise (V3 parity):
///   • pulls the raised ETH out of the curve,
///   • carves the per-side rewards — platform + creator, each ≤ raise/4 (the graduation work runs on the curve's
///     own ETH, so there is no separate gas reimbursement),
///   • seeds a PERMANENT, LOCKED full-range 2-sided LP from (remaining ETH + reserve tokens); its NFT goes to the
///     LockVault (can never be pulled),
///   • streams the LEFTOVER reserve tokens (+ any token/sell LP fees) into the pad's staking pool (holder rewards),
///   • sweeps the held buy-LP carve (buyLpFloorShareBps of the ETH/buy LP fees) into the permanent floor vault.
///
/// v2 curve-phase LP-fee routing: ETH (buy) fees → 100% platform (buyLpFloorShareBps default 0; 0% to floor);
/// token (sell) fees → staking. Platform
/// and creator payouts are accrue-and-pull (`claimPlatform`/`claimCreator`), never sent inline, so a bad recipient
/// can never brick collectFees/graduate. All economic params are stamped IMMUTABLY by the factory from the governed
/// RobinV4FeeConfig — this contract cannot self-set fees.
contract RobinCurveV4 is IUnlockCallback, ReentrancyGuard {
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;

    enum Op {
        SEED,
        COLLECT,
        GRADUATE_PULL,
        RESTORE
    }

    uint48 internal constant MAX_UINT48 = type(uint48).max;
    uint256 internal constant NUDGE_MAX_FRACTION = 100; // the ceiling nudge may spend ≤ 1/100 of the reserve
    uint256 internal constant BPS = 10000;
    // Auto-graduation keeper bounty: whoever triggers graduate() is paid a flat slice of the raise, carved OFF THE
    // TOP before the waterfall, so graduation is triggered automatically with the gas paid FROM THE CURVE ETH — no
    // keeper needs a subsidy and no one has to babysit the launch. A flat bps (not tx.gasprice-based) can't be gamed
    // by a caller inflating gasprice; the absolute cap bounds it on large raises. On a cheap Orbit L2 this comfortably
    // covers the graduation tx and leaves a small tip.
    uint256 internal constant GRAD_BOUNTY_BPS = 20; // 0.2% of the raise to the graduation trigger
    uint256 internal constant GRAD_BOUNTY_MAX_WEI = 0.02 ether; // absolute ceiling (raise ≳ 10 ETH)

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
    uint16 public immutable buyLpFloorShareBps; // share of the BUY LP fee held in-curve → floor at graduation
    // v3-economics graduation waterfall — each a % (bps) of the raise; the locked LP takes the remainder, so it
    // can never be starved (the factory/config enforce platform+creator+ambush < 100%).
    uint16 public immutable platformGradBps; // platform share of the raise
    uint16 public immutable creatorGradBps; // creator share of the raise
    uint16 public immutable ambushGradBps; // ambush-vault share of the raise (active two-sided floor support)
    /// [M-9] LAUNCH-TIME creator: provenance, and the fallback when no hook governs this pool. It is NOT
    /// necessarily the payee — `claimCreator` pays `currentCreator()`, which follows the hook's repointable slot.
    address public immutable creator;

    bool public seeded;
    bool public graduated;
    uint128 public curveL; // liquidity minted at seed (removed whole at graduation)
    address public staking; // the pad's DualStaking pool — set once, platform-gated
    address public floor; // the pad's RobinFloorVault — set once, platform-gated
    address public ambush; // the pad's RobinAmbushVault (two-sided support) — set once, platform-gated

    // accrue-and-pull books (never sent inline → cannot brick collect/graduate). v2 routing:
    //   • buy (ETH) LP fee → 80% platformEthOwed (claimPlatform) + 20% floorEthOwed (→ floor at grad)
    //   • sell (token) LP fee → stays on the controller → streamed to STAKING at graduation (platform gets no token)
    uint256 public platformEthOwed;
    uint256 public floorEthOwed; // the buyLpFloorShareBps carve of buy fees, swept to the floor at graduation
    uint256 public creatorEthOwed; // the creator-side graduation reward (claimCreator)
    uint256 public ambushEthOwed; // the ambushGradBps share of the raise, swept to the ambush vault at graduation
    mapping(address => uint256) public gasBountyOwed; // graduation keeper bounty booked here iff its inline send failed
    uint256 public totalGasBountyOwed; // running sum of gasBountyOwed, so sweepToPlatform never mis-books a pending bounty
    // [L-8] ETH the anti-grief nudge pulled out of THIRD-PARTY planted liquidity below the ceiling during
    // _graduatePull. There is no curve liquidity below gradTick, so this is never legitimate raise — it is excluded
    // from raisedEth and falls through to the step-9 platform sweep (a griefer's ETH → platform, not LP/creator).
    // Set inside _graduatePull, consumed once in graduate(); the `graduated` one-shot makes a reset unnecessary.
    uint256 private _nudgeEthExcluded;

    event Seeded(uint128 liquidity, uint256 tokens);
    event CurveFeesAccrued(uint256 eth, uint256 tokenFees);
    event PlatformClaimed(uint256 eth, address to);
    event CreatorClaimed(uint256 eth, address to);
    event StakingSet(address staking);
    event FloorSet(address floor);
    event AmbushSet(address ambush);
    event Graduated(
        uint256 lpTokenId,
        uint256 raisedEth,
        uint256 toStaking,
        uint256 platformReward,
        uint256 creatorReward,
        uint256 ambushReward
    );
    event StakingFunded(uint256 amount);
    event FloorFunded(uint256 amount);
    event AmbushFunded(uint256 amount);
    event GradBountyPaid(address indexed keeper, uint256 amount, bool booked);
    event GradBountyClaimed(address indexed to, uint256 amount);
    event PlatformSwept(uint256 eth);
    event CeilingRestored(address indexed by, uint256 tokenSpent, uint256 ethOut);

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
    error EthSendFailed();
    error StakingAssetMismatch();
    error BadPriceLimit();

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
        uint16 buyLpFloorShareBps_,
        uint16 platformGradBps_,
        uint16 creatorGradBps_,
        uint16 ambushGradBps_,
        address creator_
    ) {
        if (
            poolManager_ == address(0) || positionManager_ == address(0) || permit2_ == address(0)
                || stateView_ == address(0) || lockVault_ == address(0) || factory_ == address(0)
                || feeRegistry_ == address(0) || creator_ == address(0)
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
        buyLpFloorShareBps = buyLpFloorShareBps_;
        platformGradBps = platformGradBps_;
        creatorGradBps = creatorGradBps_;
        ambushGradBps = ambushGradBps_;
        creator = creator_;
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

    /// @notice Forward accrued platform LP fees (+ graduation reward + post-graduation dust) to the platform
    /// wallet. Permissionless; the only sink is the governed wallet. Standalone + retriable, so a bad recipient
    /// can never brick the pad. Platform is paid in ETH only — the token (sell) LP fee goes to staking.
    function claimPlatform() external nonReentrant {
        uint256 e = platformEthOwed;
        if (e == 0) return;
        platformEthOwed = 0;
        address plat = feeRegistry.platformFeeWallet();
        _payEth(plat, e);
        emit PlatformClaimed(e, plat);
    }

    /// @notice The address `claimCreator` pays.
    /// [M-9] Reads the pad hook's CURRENT creator slot, so the pad's single 2-step repoint
    /// (hook.startCreatorRepoint / acceptCreatorRepoint) governs BOTH the hook's sell-tax book and this
    /// contract's graduation reward. Before this, the curve's creator was an immutable with no repoint and no
    /// `claimCreatorTo`, so a creator who moved keys — or was told to, after a compromise — kept the sell-tax
    /// stream and permanently lost the graduation reward to the old address.
    /// Falls back to the launch-time immutable when no hook governs this pool: a directly-deployed curve
    /// (`hooks == address(0)`), a pool the hook never registered, or a hook that cannot be read.
    function currentCreator() public view returns (address) {
        // [H-3] length-checked staticcall, NOT try/catch: try/catch does not absorb a decode failure, so a
        // short-returning hook would make this revert uncatchably — and it sits on the claim path.
        (bool ok, bytes memory data) =
            address(hooks).staticcall(abi.encodeCall(IRobinFeeHookCreator.creatorOf, (_poolId())));
        if (!ok || data.length < 32) return creator;
        address c;
        // masked mload rather than abi.decode: the ABI decoder still reverts on an address word with dirty
        // high bytes, which would re-open the same uncatchable-revert hole this guard exists to close.
        assembly ("memory-safe") {
            c := and(mload(add(data, 32)), 0xffffffffffffffffffffffffffffffffffffffff)
        }
        return c == address(0) ? creator : c;
    }

    /// @notice Forward the accrued creator-side graduation reward to `currentCreator()`. Permissionless;
    /// retriable (restores the book on a failed send so a reverting creator can never trap the ETH permanently).
    function claimCreator() external nonReentrant {
        uint256 c = creatorEthOwed;
        if (c == 0) return;
        address to = currentCreator(); // resolve BEFORE the state write — never between the zeroing and the send
        creatorEthOwed = 0;
        (bool ok,) = payable(to).call{value: c}("");
        if (!ok) {
            creatorEthOwed = c; // restore → retriable
            revert EthSendFailed();
        }
        emit CreatorClaimed(c, to);
    }

    /// @notice Claim a graduation keeper bounty that was booked because its inline send failed at graduation.
    /// Permissionless; retriable (re-parks on a failed send so a reverting keeper can never trap the ETH).
    function claimGasBounty(address to) external nonReentrant {
        uint256 a = gasBountyOwed[to];
        if (a == 0) return;
        gasBountyOwed[to] = 0;
        totalGasBountyOwed -= a;
        (bool ok,) = payable(to).call{value: a}("");
        if (!ok) {
            gasBountyOwed[to] = a; // restore → retriable
            totalGasBountyOwed += a;
            revert EthSendFailed();
        }
        emit GradBountyClaimed(to, a);
    }

    /// @notice [audit] Book any ETH that arrived AFTER graduation — chiefly the curve-buffer carve the hook keeps
    /// taking on post-graduation buys (forwarded here by `hook.claimBuffer`), plus any stray donation — into the
    /// PLATFORM book so it reaches the platform wallet via `claimPlatform`. Without this, post-graduation buffer ETH
    /// would strand on the curve forever (graduate() is one-shot and only that path booked raw balance). Permissionless,
    /// graduated-only, and it never touches the still-outstanding creator/floor/ambush/gas-bounty books.
    function sweepToPlatform() external nonReentrant {
        if (!graduated) revert NotReady();
        uint256 booked = platformEthOwed + creatorEthOwed + floorEthOwed + ambushEthOwed + totalGasBountyOwed;
        uint256 bal = address(this).balance;
        if (bal <= booked) return; // nothing new arrived
        uint256 fresh = bal - booked;
        platformEthOwed += fresh;
        emit PlatformSwept(fresh);
    }

    // ── graduation ────────────────────────────────────────────────────────────────

    function ready() public view returns (bool) {
        if (!seeded || graduated) return false;
        // [L-16] Gate on the SQRT PRICE, not the tick. The nudge (line ~629) and CeilingNotRestored both compare
        // sqrt price, and the state `tick == gradTick && spot > gradSqrt` (inside tick gradTick, above its lower
        // boundary) passes `tick <= gradTick` while the curve is NOT fully sold — seeding the LP there would leak
        // the exact bps [HIGH-2] guards. Spot at/below the ceiling boundary == fully sold.
        (uint160 sp,,,) = stateView.getSlot0(_poolId());
        return sp <= TickMath.getSqrtPriceAtTick(gradTick);
    }

    /// @notice Graduate at the ceiling. Waterfall on the raised ETH (V3 parity): carve the per-side rewards
    /// (platform + creator, each ≤ raise/4) FIRST, then seed the
    /// permanent LOCKED 2-sided LP from (remaining ETH + reserve), stream the leftover token → staking, and
    /// sweep the held buy-LP carve → the permanent floor. Permissionless; CEI-ordered; unbrickable.
    function graduate() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        // [L-16] Gate on the SQRT PRICE, not the tick (matches ready(), the nudge, and CeilingNotRestored). This
        // forecloses the `tick == gradTick && spot > gradSqrt` window that let the LP seed above the ceiling.
        (uint160 curSqrt,,,) = stateView.getSlot0(_poolId());
        if (curSqrt > TickMath.getSqrtPriceAtTick(gradTick)) revert NotReady(); // curve not fully sold yet
        graduated = true; // CEI: flip before any external interaction

        // Pull any buy-tax buffer the hook has parked (buyBufferShareBps carve, in ETH — the money side) into this
        // contract BEFORE the donatedBefore snapshot below, so it is EXCLUDED from the measured raise (it is a
        // platform reward, not raise capital) and then swept to the PLATFORM book by the final step-9 balance sweep.
        // The buffer sits in the curve as ETH through the whole curve phase, then returns to the platform at grad —
        // it never perturbs the raise/LP accounting. Guarded by a code check (a codeless hook — e.g. a hookless test
        // pool — would revert the typed call UNCAUGHT by try/catch), then try/caught + outside the PoolManager lock
        // ⇒ a reverting/unwired hook can never brick graduation.
        if (address(hooks).code.length > 0) {
            try IRobinFeeHookBuffer(address(hooks)).claimBuffer(_poolId()) {} catch {}
        }

        // [AUDIT-HIGH] Snapshot any pre-existing UNBOOKED ETH (e.g. a hostile donation to receive()) BEFORE the
        // pull, so it is never counted as raise. Deriving the raise from raw balance let a donor inflate lpEth
        // past the reserve's pairing capacity and brick the LP mint (InsufficientReserve) permanently. Instead we
        // measure the NET new unbooked ETH the pull delivers; the donation falls through to the step-10 sweep.
        uint256 donatedBefore = address(this).balance - platformEthOwed - floorEthOwed; // creatorEthOwed == 0 pre-grad

        // 1) pull the raise out of the curve. The unlock FIRST nudges spot back up to the exact ceiling if a buy
        //    (or a griefer's planted liquidity) overshot below it, so the permanent LP always seeds at gradTick —
        //    never a manipulated price. Then it accrues fees and takes the principal to this contract.
        poolManager.unlock(abi.encode(Op.GRADUATE_PULL, uint256(0)));

        // 2) the raise = the NET new unbooked ETH the pull delivered, excluding the fee books, any pre-existing
        //    donation, AND [L-8] the anti-grief nudge's ETH (swap proceeds from third-party planted liquidity below
        //    the ceiling — never legitimate raise; it falls through to the step-9 platform sweep). A fully-sold curve
        //    yields ~0 token, so the LP token leg is the held-back RESERVE (all on-hand token → LP then staking).
        uint256 raisedEth = (address(this).balance - platformEthOwed - floorEthOwed) - donatedBefore - _nudgeEthExcluded;
        uint256 tokenReserve = IERC20(token).balanceOf(address(this));
        if (raisedEth == 0) revert EmptyRaise();
        if (tokenReserve == 0) revert NoReserve(); // [CRITICAL-1] must have a held-back reserve to pair the LP

        // 3) carve the auto-graduation keeper bounty OFF THE TOP (flat slice, capped), then run the V3-parity
        //    waterfall on what's left. Each bucket is a % (bps) of the DISTRIBUTABLE raise; the LOCKED LP takes the
        //    whole remainder, so it can never be starved (config enforces platform+creator+ambush < 100%). The
        //    graduation runs on the curve's OWN ETH and pays its trigger from it, so nobody has to babysit the launch.
        uint256 bounty = (raisedEth * GRAD_BOUNTY_BPS) / BPS;
        if (bounty > GRAD_BOUNTY_MAX_WEI) bounty = GRAD_BOUNTY_MAX_WEI;
        uint256 distributable = raisedEth - bounty;
        uint256 platReward = (distributable * platformGradBps) / BPS;
        uint256 creatReward = (distributable * creatorGradBps) / BPS;
        uint256 ambushReward = (distributable * ambushGradBps) / BPS;
        uint256 lpEth = distributable - platReward - creatReward - ambushReward;
        if (lpEth == 0) revert EmptyRaise();

        // 4) seed the PERMANENT LOCKED full-range 2-sided LP (NFT → LockVault). The reserve is sized so the ETH
        //    leg binds; the surplus reserve tokens stay here for staking.
        uint256 lpTokenId = _mintPermanentLp(lpEth, tokenReserve);

        // 5) register the lock through the factory (LockVault's sole registrar) — carries the immutable slice
        ICurveFactoryCallback(factory).onGraduated(lpTokenId, currency0, currency1, staking);

        // 6) book the per-side rewards (retriable via claim*/flush*; never inline-brick graduation)
        platformEthOwed += platReward;
        creatorEthOwed += creatReward;
        ambushEthOwed += ambushReward;

        // 7) stream the leftover reserve tokens → staking (non-bricking; flushStaking() finishes if unwired)
        uint256 leftoverToken = IERC20(token).balanceOf(address(this));
        _fundStaking(leftoverToken);

        // 8) sweep the held buy-LP carve → the permanent floor (non-bricking; flushFloor() finishes if unwired)
        _fundFloor();

        // 8b) sweep the ambush share → the two-sided ambush vault (non-bricking; flushAmbush() finishes if unwired)
        _fundAmbush();

        // 9) reserve the keeper bounty, sweep any remaining unbooked ETH dust → platform book (preserving the floor
        //    + creator + ambush books still owed), then pay the bounty LAST (max reentrancy distance; all state is
        //    final). A failed send books it to gasBountyOwed (retriable via claimGasBounty) — never traps, never
        //    lets the platform book absorb the keeper's ETH.
        platformEthOwed = address(this).balance - floorEthOwed - creatorEthOwed - ambushEthOwed - bounty;
        emit Graduated(lpTokenId, raisedEth, leftoverToken, platReward, creatReward, ambushReward);
        if (bounty > 0) {
            (bool ok,) = payable(msg.sender).call{value: bounty}("");
            if (!ok) {
                gasBountyOwed[msg.sender] += bounty;
                totalGasBountyOwed += bounty;
            }
            emit GradBountyPaid(msg.sender, bounty, !ok);
        }
    }

    /// @notice Finish staking funding if the pool wasn't wired/listed at graduation. Permissionless. Sweeps all
    /// on-hand token (platform is never owed token in v2, so the whole balance is staking's).
    function flushStaking() external nonReentrant {
        if (!graduated) revert NotReady();
        address s = staking;
        if (s == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(s, bal);
        IStakingFund(s).fundTokenPushed(uint8(0), token); // Side.TOKEN; credits balanceOf - accountedReserve
        emit StakingFunded(bal);
    }

    /// @notice Finish floor funding if the floor vault wasn't wired at graduation (or its add was skipped because
    /// spot was inside the band). Permissionless; retriable.
    function flushFloor() external nonReentrant {
        if (!graduated) revert NotReady();
        if (floor == address(0)) revert ZeroAddress();
        _fundFloor();
    }

    /// @notice Finish ambush funding if the ambush vault wasn't wired at graduation. Permissionless; retriable.
    function flushAmbush() external nonReentrant {
        if (!graduated) revert NotReady();
        if (ambush == address(0)) revert ZeroAddress();
        _fundAmbush();
    }

    /// @notice Permissionless anti-grief recovery for graduation. A third party can plant Uniswap-v4 liquidity
    /// BELOW gradTick and push spot under the ceiling; graduate()'s reserve-budgeted nudge (≤1% of the reserve)
    /// then can't buy back through that planted depth, so it reverts CeilingNotRestored and the raise is stuck.
    /// This lets ANYONE push spot back UP to the ceiling using their OWN token (never the curve reserve, so the
    /// permanent-LP token leg is never starved): the supplied token is swapped → ETH up to the gradTick limit,
    /// and BOTH the ETH proceeds and any unspent token are refunded to the caller — a fair swap that merely
    /// undoes the manipulation (the caller reclaims the griefer's planted ETH as they restore the price). After
    /// this, graduate() finds spot at the ceiling and proceeds normally.
    ///
    /// [C-2] `sqrtPriceLimitX96` makes the walk SEGMENTABLE, which is what turns an unrecoverable brick into a
    /// recoverable one. An ordinary sellout leaves spot at the far floor (measured: tick −887272), so the walk
    /// back to gradTick crosses ~890k ticks. Empty ticks are skipped a bitmap word at a time and cost almost
    /// nothing, but every INITIALIZED tick costs real gas — and initializing one is nearly free when spot is far
    /// below it. Measured: 100 positions of `liquidityDelta = 1` cost the attacker 100 wei plus ~161k gas each,
    /// spread over as many deadline-free transactions as they like, and pushed both graduate() (33.8M) and this
    /// function (31.8M) past the 30M block cap — permanently trapping 63.7 ETH of raise. The recovery was
    /// defeated by the exact thing it existed to recover from, because a single unbounded swap cannot be split.
    /// With a caller-supplied intermediate limit anyone can walk spot up in as many transactions as it takes,
    /// each one bounded by its own gas, until the final segment lands exactly at the ceiling.
    /// @param sqrtPriceLimitX96 intermediate price to stop at; must be ABOVE spot and at/below the ceiling.
    ///        Pass 0 for "walk all the way to the ceiling" (the honest, empty-zone case — one transaction).
    function restoreCeiling(uint256 tokenIn, uint160 sqrtPriceLimitX96)
        external
        nonReentrant
        returns (uint256 ethOut, uint256 tokenRefunded)
    {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        if (tokenIn == 0) revert BadLiquidity();
        uint160 gradSqrt = TickMath.getSqrtPriceAtTick(gradTick);
        (uint160 curSqrt,,,) = stateView.getSlot0(_poolId());
        if (curSqrt >= gradSqrt) revert NotReady(); // already at/above the ceiling
        // A segment may only move spot UP and may never overshoot the ceiling, so no sequence of segments can
        // reach a state a single full-walk call could not. `> curSqrt` also rejects the degenerate limit-equals-
        // current case, which v4 rejects with PriceLimitAlreadyExceeded.
        if (sqrtPriceLimitX96 == 0) sqrtPriceLimitX96 = gradSqrt;
        if (sqrtPriceLimitX96 <= curSqrt || sqrtPriceLimitX96 > gradSqrt) revert BadPriceLimit();
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenIn);
        uint256 consumed;
        (ethOut, consumed) =
            abi.decode(poolManager.unlock(abi.encode(Op.RESTORE, tokenIn, sqrtPriceLimitX96)), (uint256, uint256));
        tokenRefunded = tokenIn - consumed;
        if (tokenRefunded > 0) IERC20(token).safeTransfer(msg.sender, tokenRefunded);
        if (ethOut > 0) {
            (bool ok,) = payable(msg.sender).call{value: ethOut}("");
            if (!ok) revert EthSendFailed();
        }
        emit CeilingRestored(msg.sender, consumed, ethOut);
    }

    /// @notice Wire the pad's staking pool exactly once, by the platform (deployed after launch).
    /// [M-25] The whole graduation leftover (measured at ~9.7% of supply) is pushed to this address and this
    /// setter is a ONE-SHOT with no rescue path, so the sink's stake asset is checked here — the push-then-poke
    /// funding path cannot detect a foreign sink on its own (it transfers first, and `fundTokenPushed` measures
    /// the sink's own balance, so a foreign sink pockets the tokens and returns 0 without reverting).
    function setStaking(address s) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        if (staking != address(0)) revert AlreadySet();
        if (s == address(0) || s.code.length == 0) revert ZeroAddress(); // [LOW-3] must be a contract (the pool)
        if (_probeStakeAsset(s) != token) revert StakingAssetMismatch();
        // [R3-N2] the token treasury PASSES the asset probe (its token() IS the pad token), but the reservoir must
        // land 100% on a staking pool — never through the 70/30 splitter (30% of the dump would burn). Reject the
        // splitter shape so "the reservoir can never route through the treasury" is contract-enforced, not
        // operator discipline. Pools have no fallback, so this staticcall cleanly fails for them.
        (bool splitter, bytes memory sd) = s.staticcall(abi.encodeCall(ITreasurySplitProbe.TO_STAKING_BPS, ()));
        if (splitter && sd.length == 32) revert StakingAssetMismatch();
        staking = s;
        emit StakingSet(s);
    }

    /// @dev Read a staking sink's TOKEN-side stake asset, trying both names in use. Returns address(0) when the
    /// target answers neither — which fails the caller's equality check, since `token` is never address(0).
    /// [H-3] Both probes check `data.length == 32`: a target whose fallback returns short or empty data would
    /// otherwise make `abi.decode` revert (try/catch does NOT catch a decode failure) or decode garbage.
    function _probeStakeAsset(address s) internal view returns (address) {
        (bool ok, bytes memory data) = s.staticcall(abi.encodeCall(IStakeAssetProbe.token, ()));
        if (!ok || data.length != 32) {
            (ok, data) = s.staticcall(abi.encodeCall(IStakeAssetProbe.tokenAsset, ()));
            if (!ok || data.length != 32) return address(0);
        }
        return abi.decode(data, (address));
    }

    /// @notice Wire the pad's permanent floor vault exactly once, by the platform (deployed after launch). The
    /// held buy-LP carve (floorEthOwed) is swept here at graduation.
    function setFloor(address f) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        if (floor != address(0)) revert AlreadySet();
        if (f == address(0) || f.code.length == 0) revert ZeroAddress(); // must be a contract (the vault)
        // [M-21] floorEthOwed's ONLY exit is a plain value transfer to this address, and this setter is a
        // one-shot with no re-point. Prove the target can accept one BEFORE spending it: a contract with
        // neither receive() nor a payable fallback reverts here, instead of silently re-parking the carve
        // forever while flushFloor() keeps returning success.
        (bool ok,) = f.call{value: 0}("");
        if (!ok) revert EthSendFailed();
        floor = f;
        emit FloorSet(f);
    }

    /// @notice Wire the pad's two-sided ambush vault exactly once, by the platform (deployed after launch). The
    /// ambush share of the raise (ambushEthOwed) is swept here at graduation to arm active floor support.
    function setAmbush(address a) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        if (ambush != address(0)) revert AlreadySet();
        if (a == address(0) || a.code.length == 0) revert ZeroAddress(); // must be a contract (the vault)
        // [M-21] same as setFloor: ambushEthOwed can only ever leave by a value transfer to this address, and
        // the setter cannot be re-pointed. Reject a target that cannot take a plain send.
        (bool ok,) = a.call{value: 0}("");
        if (!ok) revert EthSendFailed();
        ambush = a;
        emit AmbushSet(a);
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
        } else if (op == Op.RESTORE) {
            (, uint256 tokenIn, uint160 limit) = abi.decode(data, (Op, uint256, uint160));
            return _restore(tokenIn, limit);
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
        // Compare SQRT PRICE, not tick. A buy capped exactly at the ceiling lands sqrtPrice == gradSqrt but
        // tick == gradTick-1 (downward-crossing convention) — that is already AT the ceiling, so the nudge must
        // be SKIPPED; running it would swap with limit == current price and revert PriceLimitAlreadyExceeded.
        uint160 gradSqrt = TickMath.getSqrtPriceAtTick(gradTick);
        (uint160 curSqrt,,,) = stateView.getSlot0(_poolId());
        if (curSqrt < gradSqrt) {
            // Budget the nudge to ≤1% of the reserve ONLY (never the platform fee book — that avoids the
            // underflow at raisedEth/tokenReserve below), and FAIL CLOSED: if it can't restore spot to the
            // exact ceiling (e.g. a griefer planted deep liquidity under gradTick), revert rather than bleed the
            // reserve into their position (restoreCeiling() then recovers it with caller-supplied token). In the
            // honest overshoot case the zone below gradTick is empty, so the swap crosses it for ~0 and lands
            // exactly at gradTick.
            uint256 budget = IERC20(token).balanceOf(address(this)) / NUDGE_MAX_FRACTION;
            if (budget == 0) budget = 1; // [D-1] never truncate to 0 (tiny/low-decimal reserve) → false brick
            {
                BalanceDelta sd = poolManager.swap(
                    key,
                    SwapParams({
                        zeroForOne: false, // token-in → price UP toward the ceiling
                        amountSpecified: -int256(budget),
                        sqrtPriceLimitX96: gradSqrt
                    }),
                    ""
                );
                _resolve(currency0, sd.amount0()); // take any ETH out
                _resolve(currency1, sd.amount1()); // settle the (tiny) token consumed
                // [L-8] Record the nudge's ETH proceeds so graduate() can exclude them from the raise. In the honest
                // overshoot case the zone below gradTick is empty, so this is ~0 and honest raise is unchanged.
                _nudgeEthExcluded = sd.amount0() > 0 ? uint256(uint128(sd.amount0())) : 0;
            }
            (uint160 nowSqrt,,,) = stateView.getSlot0(_poolId());
            if (nowSqrt != gradSqrt) revert CeilingNotRestored(); // never seed the permanent LP at a fake price
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

    /// @dev Swap exactly the caller-supplied token → ETH, price UP toward `limit` (validated by the wrapper to sit
    /// above spot and at/below the ceiling). Returns the ETH taken out (refunded to the caller) and the token
    /// actually consumed. Never touches the curve reserve: the token leg is settled from the caller's
    /// just-transferred tokenIn (surplus refunded by the external wrapper), and only the swap's own ETH output is
    /// taken here. [C-2] `limit` is a parameter rather than always gradSqrt so the walk can be split across
    /// transactions when planted ticks make a single full walk exceed the block gas cap.
    function _restore(uint256 tokenIn, uint160 limit) internal returns (bytes memory) {
        BalanceDelta sd = poolManager.swap(
            _poolKey(),
            SwapParams({
                zeroForOne: false, // token-in → price UP toward the ceiling
                amountSpecified: -int256(tokenIn),
                sqrtPriceLimitX96: limit
            }),
            ""
        );
        int128 a0 = sd.amount0();
        int128 a1 = sd.amount1();
        uint256 ethOut = a0 > 0 ? uint256(uint128(a0)) : 0;
        uint256 consumed = a1 < 0 ? uint256(uint128(-a1)) : 0;
        _resolve(currency0, a0); // take ETH out to this contract (refunded to the caller by restoreCeiling)
        _resolve(currency1, a1); // settle the token consumed from the transferred tokenIn
        return abi.encode(ethOut, consumed);
    }

    /// @dev Take a fee delta to this contract and route it per the v2 model:
    ///   • ETH (buy) fee → buyLpFloorShareBps to the floor book, the rest to the platform book,
    ///   • token (sell) fee → stays on the controller (no book) → streamed to STAKING at graduation.
    function _takeFeesToBook(BalanceDelta delta) internal returns (uint256 e, uint256 t) {
        int128 a0 = delta.amount0();
        int128 a1 = delta.amount1();
        if (a0 > 0) {
            e = uint256(uint128(a0));
            poolManager.take(currency0, address(this), e);
            uint256 toFloor = (e * buyLpFloorShareBps) / BPS; // 20% held → floor at graduation
            floorEthOwed += toFloor;
            platformEthOwed += e - toFloor; // 80% → platform (claimPlatform)
        }
        if (a1 > 0) {
            t = uint256(uint128(a1));
            poolManager.take(currency1, address(this), t); // held on the controller → staking at graduation
        }
    }

    function _mintPermanentLp(uint256 ethAmt, uint256 tokAvail) internal returns (uint256 tokenId) {
        PoolKey memory key = _poolKey();
        int24 tl = TickMath.minUsableTick(tickSpacing);
        int24 tu = TickMath.maxUsableTick(tickSpacing);
        // Spot is guaranteed == gradTick here (the nudge + CeilingNotRestored check), so price at the canonical
        // ceiling. [HIGH-2] Size the LP by the ETH leg so the WHOLE lpEth (raise minus rewards+gas) binds into the
        // locked position — never let the token leg bind and leak unbound ETH to the platform book. Revert if the
        // reserve can't cover the token side lpEth requires (fail closed; the launch-time check makes this rare).
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

    /// @dev Sweep the held buy-LP carve (floorEthOwed) into the permanent floor vault. Non-bricking: if the floor
    /// isn't wired yet the ETH stays booked (flushFloor completes later); a failed send re-parks the book; and the
    /// floor's addFloor poke is try/caught (if spot is inside the band the vault parks the quote itself).
    function _fundFloor() internal {
        address f = floor;
        uint256 amt = floorEthOwed;
        if (f == address(0) || amt == 0) return; // parks in the book; flushFloor() completes later
        floorEthOwed = 0;
        (bool ok,) = payable(f).call{value: amt}("");
        if (!ok) {
            floorEthOwed = amt; // re-park → retriable
            return;
        }
        try IFloorVault(f).addFloor() {} catch {} // poke; the vault parks the quote if spot is inside the band
        emit FloorFunded(amt);
    }

    /// @dev Sweep the ambush share (ambushEthOwed) into the two-sided ambush vault. Non-bricking: if the vault
    /// isn't wired yet the ETH stays booked (flushAmbush completes later); a failed send re-parks the book. The
    /// vault holds the ETH and arms its own two-sided support (buy dips / sell rips) off its balance.
    function _fundAmbush() internal {
        address a = ambush;
        uint256 amt = ambushEthOwed;
        if (a == address(0) || amt == 0) return; // parks in the book; flushAmbush() completes later
        ambushEthOwed = 0;
        (bool ok,) = payable(a).call{value: amt}("");
        if (!ok) {
            ambushEthOwed = amt; // re-park → retriable
            return;
        }
        emit AmbushFunded(amt);
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
