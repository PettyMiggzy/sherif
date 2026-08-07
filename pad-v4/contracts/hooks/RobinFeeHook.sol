// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {BaseHook} from "./BaseHook.sol";
import {
    IFeeWalletRegistry,
    IStockGuardAdapter,
    IRobinFeeHookAdmin
} from "../interfaces/IRobinInterfaces.sol";

/// @title RobinFeeHook — the 3-way afterSwap fee engine (the heart of Robin V4)
/// @notice On every exact-input swap the hook skims `feeBps` of the OUTPUT leg as an
/// ADDITIONAL fee (the trader pays LP fee + skim — nothing is "carved" from the pool,
/// because the hook holds no liquidity) and splits it three ways:
///   • platform  → accrue-and-pull to the timelocked platform wallet
///   • creator   → accrue-and-pull to the creator's own repointable slot
///   • holders   → an O(1) Synthetix-style accumulator, weighted by a per-pool weight
///                 source (DualStaking). No holder is ever iterated.
///
/// Design decisions that resolve the red-team findings (see ROBIN-V4-ARCHITECTURE.md):
///   [A1] Skim is always additional — the hook owns no position to carve from.
///   [A2] Pool uses a STATIC lp fee (not the dynamic-fee flag) so the locked seed LP
///        and the floor actually earn. beforeSwap never overrides the fee.
///   [A4/B1] Skim is EXACT-INPUT ONLY; the unspecified (output) leg is already held by
///        the PoolManager, so `take` never fronts foreign reserves. Exact-output is skim-free.
///   [D2] The fee `take` is try/caught — a blocklisted/paused stock fee currency makes the
///        skim silently skip, it never bricks the swap.
///   [F2] With no holder weight, the holder cut PARKS (never routes to platform).
///   [G1] REQUIRED_FLAGS == 0x00C4, self-asserted in the ctor and cross-checked by the factory.
///   [G2] No beforeInitialize; config is bound by `registerPool` in the same launch tx.
contract RobinFeeHook is BaseHook, IRobinFeeHookAdmin {
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencyLibrary for Currency;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant RAY = 1e27;
    uint16 public constant MAX_FEE_BPS = 300; // 3% skim ceiling, immutable
    /// @dev afterSwap returns an int128, so a skim leg must never exceed int128 max (invariant #5).
    int128 internal constant MAX_SKIM = type(int128).max;

    address public immutable factory;
    IFeeWalletRegistry public immutable feeRegistry;

    struct PoolConfig {
        bool registered;
        bool quoteIsStock;
        uint16 feeBps;
        uint16 platformShareBps;
        uint16 creatorShareBps;
        uint32 guardWindow;
        Currency currency0;
        Currency currency1;
        address creator; // 2-step repointable by the creator only
        address pendingCreator;
        address weightSource; // DualStaking; 0 => park holder cut
        address guardAdapter; // stock guard; 0 => no curb
    }

    // poolId => config (frozen at registerPool except the creator's own slot)
    mapping(PoolId => PoolConfig) public config;

    // Accrue-and-pull books. currencyIndex ∈ {0,1}.
    mapping(PoolId => mapping(uint256 => uint256)) public platformOwed;
    mapping(PoolId => mapping(uint256 => uint256)) public creatorOwed;

    // O(1) holder accumulator (per pool, per currency).
    mapping(PoolId => mapping(uint256 => uint256)) public rewardPerTokenStored; // scaled by RAY
    mapping(PoolId => mapping(uint256 => uint256)) public unallocated; // parked when totalWeight==0
    mapping(PoolId => uint256) public totalWeight;
    mapping(PoolId => mapping(address => uint256)) public weightOf;
    mapping(PoolId => mapping(address => mapping(uint256 => uint256))) public userRptPaid;
    mapping(PoolId => mapping(address => mapping(uint256 => uint256))) public holderOwed;

    event PoolRegistered(PoolId indexed id, address indexed creator, uint16 feeBps);
    event Skimmed(PoolId indexed id, uint256 currencyIndex, uint256 fee, uint256 pCut, uint256 cCut, uint256 hCut);
    event SkimSkipped(PoolId indexed id, uint256 currencyIndex, uint256 fee);
    event HolderWeightChanged(PoolId indexed id, address indexed user, uint256 oldWeight, uint256 newWeight);
    event PlatformClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event CreatorClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event HolderClaimed(PoolId indexed id, address indexed user, uint256 currencyIndex, uint256 amount);
    event CreatorRepointStarted(PoolId indexed id, address pending);
    event CreatorRepointed(PoolId indexed id, address creator);

    error NotFactory();
    error AlreadyRegistered();
    error NotRegistered();
    error BadFee();
    error BadShares();
    error NotWeightSource();
    error NotCreator();
    error ZeroAddress();
    error NothingToClaim();
    error PayoutFailed();
    error CorporateActionCurb();

    constructor(IPoolManager _pm, address _factory, IFeeWalletRegistry _feeRegistry) BaseHook(_pm) {
        if (_factory == address(0) || address(_feeRegistry) == address(0)) revert ZeroAddress();
        factory = _factory;
        feeRegistry = _feeRegistry;
    }

    // --------------------------------------------------------------------- //
    //                             registration                              //
    // --------------------------------------------------------------------- //

    /// @notice Bind a pool's immutable fee config. Called ONLY by the factory, once per pool,
    /// in the same tx as `PoolManager.initialize` and before any swap can occur. [G2]
    function registerPool(PoolId id, PoolFeeConfig calldata cfg) external override {
        if (msg.sender != factory) revert NotFactory();
        if (config[id].registered) revert AlreadyRegistered();
        if (cfg.creator == address(0)) revert ZeroAddress();
        if (cfg.feeBps == 0 || cfg.feeBps > MAX_FEE_BPS) revert BadFee();
        // platform + creator must leave room for a non-negative holder remainder.
        if (uint256(cfg.platformShareBps) + uint256(cfg.creatorShareBps) > BPS) revert BadShares();

        config[id] = PoolConfig({
            registered: true,
            quoteIsStock: cfg.quoteIsStock,
            feeBps: cfg.feeBps,
            platformShareBps: cfg.platformShareBps,
            creatorShareBps: cfg.creatorShareBps,
            guardWindow: cfg.guardWindow,
            currency0: cfg.currency0,
            currency1: cfg.currency1,
            creator: cfg.creator,
            pendingCreator: address(0),
            weightSource: cfg.weightSource,
            guardAdapter: cfg.guardAdapter
        });
        emit PoolRegistered(id, cfg.creator, cfg.feeBps);
    }

    // --------------------------------------------------------------------- //
    //                              beforeSwap                               //
    // --------------------------------------------------------------------- //

    /// @notice Stock corporate-action curb only [D4]. For ETH/USDG pads (guardWindow==0)
    /// this is a single SLOAD + return. The adapter read is try/caught so a broken adapter
    /// can never freeze trading — a revert is read as "no scheduled action".
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolConfig storage c = config[key.toId()];
        if (c.guardWindow > 0 && c.quoteIsStock && c.guardAdapter != address(0)) {
            uint256 ea = _scheduledEffectiveAt(c.guardAdapter);
            if (ea != 0) {
                uint256 nowTs = block.timestamp;
                uint256 diff = nowTs > ea ? nowTs - ea : ea - nowTs;
                if (diff <= c.guardWindow) revert CorporateActionCurb();
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _scheduledEffectiveAt(address adapter) internal view returns (uint256) {
        try IStockGuardAdapter(adapter).scheduledEffectiveAt() returns (uint256 ea) {
            return ea;
        } catch {
            return 0;
        }
    }

    // --------------------------------------------------------------------- //
    //                               afterSwap                               //
    // --------------------------------------------------------------------- //

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        onlyPoolManager
        nonReentrant
        returns (bytes4, int128)
    {
        // Our own operations (fee takes, future floor/staking ops) never skim themselves.
        if (sender == address(this)) return (IHooks.afterSwap.selector, int128(0));

        PoolId id = key.toId();
        PoolConfig storage c = config[id];
        if (!c.registered || c.feeBps == 0) return (IHooks.afterSwap.selector, int128(0));

        // [A4/B1] EXACT-INPUT ONLY. amountSpecified < 0 == exact-input; the unspecified leg is
        // the OUTPUT, which the PoolManager already holds, so `take` never fronts reserves.
        if (params.amountSpecified >= 0) return (IHooks.afterSwap.selector, int128(0));

        // Unspecified (output) currency index: selling token0→token1 (zeroForOne) outputs currency1.
        uint256 uc = params.zeroForOne ? 1 : 0;
        int128 ucAmt = uc == 0 ? delta.amount0() : delta.amount1();
        // Output leg is credited to the swapper => positive. Guard defensively anyway.
        uint256 mag = ucAmt > 0 ? uint256(uint128(ucAmt)) : uint256(uint128(-ucAmt));
        if (mag == 0) return (IHooks.afterSwap.selector, int128(0));

        uint256 fee = (mag * c.feeBps) / BPS; // rounds down; truncation dust stays with the trader
        if (fee == 0) return (IHooks.afterSwap.selector, int128(0));
        // Clamp to int128 max so the returned delta can represent it (invariant #5).
        if (fee > uint256(uint128(MAX_SKIM))) fee = uint256(uint128(MAX_SKIM));

        Currency ucCurrency = uc == 0 ? key.currency0 : key.currency1;

        // [D2] Guard the take. A blocklisted/paused stock fee currency must NOT brick the swap.
        try poolManager.take(ucCurrency, address(this), fee) {
            // ok — hook now holds `fee` of the output currency and owes `fee` on its delta,
            // which the returned +fee below nets back to zero.
        } catch {
            emit SkimSkipped(id, uc, fee);
            return (IHooks.afterSwap.selector, int128(0));
        }

        uint256 pCut = (fee * c.platformShareBps) / BPS;
        uint256 cCut = (fee * c.creatorShareBps) / BPS;
        uint256 hCut = fee - pCut - cCut; // subtraction conserves all rounding dust into the holder bucket

        platformOwed[id][uc] += pCut;
        creatorOwed[id][uc] += cCut;
        _accrueHolders(id, uc, hCut);

        emit Skimmed(id, uc, fee, pCut, cCut, hCut);
        // Return the +fee delta LAST (CEI). Nets the -fee from `take` → unlock closes clean.
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    // --------------------------------------------------------------------- //
    //                        O(1) holder accumulator                        //
    // --------------------------------------------------------------------- //

    /// @dev [F2] Park when there is no weight; NEVER route holder funds to the platform.
    function _accrueHolders(PoolId id, uint256 c, uint256 amt) internal {
        if (amt == 0) return;
        uint256 ts = totalWeight[id];
        if (ts == 0) {
            unallocated[id][c] += amt;
            return;
        }
        uint256 pending = amt + unallocated[id][c];
        unallocated[id][c] = 0;
        uint256 inc = (pending * RAY) / ts;
        rewardPerTokenStored[id][c] += inc;
        // carry the truncation remainder forward so no dust is lost
        unallocated[id][c] += pending - (inc * ts) / RAY;
    }

    /// @notice Called by the pool's weight source (DualStaking) on every stake/unstake.
    /// Settles the user's owed rewards at the OLD weight for BOTH currencies, then re-weights.
    function onWeightChange(PoolId id, address user, uint256 newWeight) external {
        PoolConfig storage cfg = config[id];
        if (msg.sender != cfg.weightSource || cfg.weightSource == address(0)) revert NotWeightSource();

        uint256 old = weightOf[id][user];
        // settle both currency legs at the old weight before the weight moves
        _settleHolder(id, user, 0, old);
        _settleHolder(id, user, 1, old);

        weightOf[id][user] = newWeight;
        totalWeight[id] = totalWeight[id] - old + newWeight;
        emit HolderWeightChanged(id, user, old, newWeight);
    }

    function _settleHolder(PoolId id, address user, uint256 c, uint256 w) internal {
        uint256 rpt = rewardPerTokenStored[id][c];
        uint256 paid = userRptPaid[id][user][c];
        if (w != 0 && rpt > paid) {
            holderOwed[id][user][c] += (w * (rpt - paid)) / RAY;
        }
        userRptPaid[id][user][c] = rpt;
    }

    // --------------------------------------------------------------------- //
    //                                claims                                 //
    // --------------------------------------------------------------------- //

    /// @notice Pull the platform's accrued cut for one currency to the timelocked platform wallet.
    /// Permissionless — funds always go to the registry's current wallet, never to the caller.
    function claimPlatform(PoolId id, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        amount = platformOwed[id][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        platformOwed[id][currencyIndex] = 0;
        address to = feeRegistry.platformFeeWallet();
        _payout(_currencyAt(id, currencyIndex), to, amount);
        emit PlatformClaimed(id, currencyIndex, to, amount);
    }

    /// @notice Pull the creator's accrued cut for one currency to the creator's slot.
    /// Permissionless — funds always go to the registered creator address, never the caller.
    function claimCreator(PoolId id, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        amount = creatorOwed[id][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        creatorOwed[id][currencyIndex] = 0;
        address to = config[id].creator;
        _payout(_currencyAt(id, currencyIndex), to, amount);
        emit CreatorClaimed(id, currencyIndex, to, amount);
    }

    /// @notice [F1] Per-currency holder claim. A blocked stock leg fails only its own leg;
    /// the ETH/token leg is untouched. `user` claims to themselves.
    function claimHolder(PoolId id, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        address user = msg.sender;
        _settleHolder(id, user, currencyIndex, weightOf[id][user]);
        amount = holderOwed[id][user][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        holderOwed[id][user][currencyIndex] = 0;
        _payout(_currencyAt(id, currencyIndex), user, amount);
        emit HolderClaimed(id, user, currencyIndex, amount);
    }

    /// @notice View a holder's currently-claimable amount for one currency (settled + pending).
    function holderClaimable(PoolId id, address user, uint256 currencyIndex) external view returns (uint256) {
        uint256 w = weightOf[id][user];
        uint256 rpt = rewardPerTokenStored[id][currencyIndex];
        uint256 paid = userRptPaid[id][user][currencyIndex];
        uint256 pending = (w != 0 && rpt > paid) ? (w * (rpt - paid)) / RAY : 0;
        return holderOwed[id][user][currencyIndex] + pending;
    }

    // --------------------------------------------------------------------- //
    //                         creator slot repoint                          //
    // --------------------------------------------------------------------- //

    function startCreatorRepoint(PoolId id, address pending) external {
        PoolConfig storage c = config[id];
        if (msg.sender != c.creator) revert NotCreator();
        if (pending == address(0)) revert ZeroAddress();
        c.pendingCreator = pending;
        emit CreatorRepointStarted(id, pending);
    }

    function acceptCreatorRepoint(PoolId id) external {
        PoolConfig storage c = config[id];
        if (msg.sender != c.pendingCreator) revert NotCreator();
        c.creator = msg.sender;
        c.pendingCreator = address(0);
        emit CreatorRepointed(id, msg.sender);
    }

    // --------------------------------------------------------------------- //
    //                               helpers                                 //
    // --------------------------------------------------------------------- //

    function _currencyAt(PoolId id, uint256 index) internal view returns (Currency) {
        PoolConfig storage c = config[id];
        if (!c.registered) revert NotRegistered();
        return index == 0 ? c.currency0 : c.currency1;
    }

    /// @dev Native → low-level call; ERC20 → CurrencyLibrary.transfer (reverts on failure).
    /// Callers zero the owed slot before calling under the nonReentrant guard. If the send
    /// reverts, the whole claim tx reverts and the owed slot is restored — funds are never
    /// lost, the claim just fails, and the failure is isolated to that one caller/currency [F1/F3].
    function _payout(Currency currency, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (currency.isAddressZero()) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert PayoutFailed();
        } else {
            currency.transfer(to, amount);
        }
    }

    /// @dev Needed so native-ETH `take` fee collections land here.
    receive() external payable {}
}
