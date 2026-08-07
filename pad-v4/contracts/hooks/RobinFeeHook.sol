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
import {IFeeWalletRegistry, IStockGuardAdapter, IRobinFeeHookAdmin} from "../interfaces/IRobinInterfaces.sol";

/// @title RobinFeeHook — directional trade-tax engine (the heart of Robin V4)
/// @notice On every exact-input swap the hook skims an ADDITIONAL fee from the OUTPUT leg (the trader
/// pays LP fee + tax — nothing is "carved" from the pool, because the hook holds no liquidity) and
/// routes it by DIRECTION:
///
///   • BUY  (quote → token, `zeroForOne`): `buyTaxBps` of the TOKEN output  → platform
///   • SELL (token → quote, `oneForZero`): `sellTaxBps` of the QUOTE output → creator, minus a
///          `sellFloorShareBps` carve that funds the pad's permanent price FLOOR.
///
/// Holders are rewarded separately, by staking (DualStaking) — funded by the sell-side LP fee — so the
/// hook itself has no holder accumulator. All payouts are accrue-and-pull: nothing is pushed to an
/// external wallet inside a swap, so a reverting recipient can never block trading.
///
/// Red-team invariants preserved from the spine:
///   [A1] The skim is always ADDITIONAL (the hook owns no position to carve from).
///   [A2] The pool uses a STATIC lp fee; beforeSwap never overrides it (only the stock curb lives there).
///   [A4/B1] Skim is EXACT-INPUT ONLY; the unspecified (output) leg is already held by the PoolManager,
///           so `take` never fronts foreign reserves. Exact-output is skim-free.
///   [D2] The fee `take` is try/caught — a blocklisted/paused stock fee currency skips the skim, never bricks.
///   [G1] REQUIRED_FLAGS == 0x00C4, self-asserted in the ctor and cross-checked by the factory.
///   [G2] No beforeInitialize; config is bound by `registerPool` in the same launch tx.
contract RobinFeeHook is BaseHook, IRobinFeeHookAdmin {
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencyLibrary for Currency;

    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_TAX_BPS = 300; // 3% per-direction ceiling, immutable
    /// @dev afterSwap returns an int128, so a skim leg must never exceed int128 max.
    int128 internal constant MAX_SKIM = type(int128).max;

    address public immutable factory;
    IFeeWalletRegistry public immutable feeRegistry;

    struct PoolConfig {
        bool registered;
        bool quoteIsStock;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 sellFloorShareBps; // share of the sell tax carved to the floor
        uint32 guardWindow;
        Currency currency0; // quote
        Currency currency1; // token
        address creator; // 2-step repointable by the creator only
        address pendingCreator;
        address floorRecipient; // where claimFloor forwards; 0 => floor parks in floorOwed
        address guardAdapter; // stock guard; 0 => no curb
    }

    mapping(PoolId => PoolConfig) public config;

    // Accrue-and-pull books. currencyIndex ∈ {0 = quote, 1 = token}.
    mapping(PoolId => mapping(uint256 => uint256)) public platformOwed; // from buys (token leg)
    mapping(PoolId => mapping(uint256 => uint256)) public creatorOwed; // from sells (quote leg)
    mapping(PoolId => mapping(uint256 => uint256)) public floorOwed; // carve from sells (quote leg)

    event PoolRegistered(PoolId indexed id, address indexed creator, uint16 buyTaxBps, uint16 sellTaxBps);
    event BuyTaxed(PoolId indexed id, uint256 fee); // platform, token leg
    event SellTaxed(PoolId indexed id, uint256 creatorCut, uint256 floorCut); // quote leg
    event SkimSkipped(PoolId indexed id, uint256 currencyIndex, uint256 fee);
    event PlatformClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event CreatorClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event FloorClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event CreatorRepointStarted(PoolId indexed id, address pending);
    event CreatorRepointed(PoolId indexed id, address creator);

    error NotFactory();
    error AlreadyRegistered();
    error NotRegistered();
    error BadTax();
    error BadShares();
    error NotCreator();
    error ZeroAddress();
    error NoFloorRecipient();
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

    /// @notice Bind a pool's immutable fee config. Factory-only, once per pool, in the launch tx. [G2]
    function registerPool(PoolId id, PoolFeeConfig calldata cfg) external override {
        if (msg.sender != factory) revert NotFactory();
        if (config[id].registered) revert AlreadyRegistered();
        if (cfg.creator == address(0)) revert ZeroAddress();
        if (cfg.buyTaxBps > MAX_TAX_BPS || cfg.sellTaxBps > MAX_TAX_BPS) revert BadTax();
        if (cfg.buyTaxBps == 0 && cfg.sellTaxBps == 0) revert BadTax();
        if (cfg.sellFloorShareBps > BPS) revert BadShares();

        config[id] = PoolConfig({
            registered: true,
            quoteIsStock: cfg.quoteIsStock,
            buyTaxBps: cfg.buyTaxBps,
            sellTaxBps: cfg.sellTaxBps,
            sellFloorShareBps: cfg.sellFloorShareBps,
            guardWindow: cfg.guardWindow,
            currency0: cfg.currency0,
            currency1: cfg.currency1,
            creator: cfg.creator,
            pendingCreator: address(0),
            floorRecipient: cfg.floorRecipient,
            guardAdapter: cfg.guardAdapter
        });
        emit PoolRegistered(id, cfg.creator, cfg.buyTaxBps, cfg.sellTaxBps);
    }

    // --------------------------------------------------------------------- //
    //                              beforeSwap                               //
    // --------------------------------------------------------------------- //

    /// @notice Stock corporate-action curb only [D4]. For ETH/USDG pads (guardWindow==0) this is a
    /// single SLOAD + return. The adapter read is try/caught so a broken adapter can never freeze trading.
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
        if (sender == address(this)) return (IHooks.afterSwap.selector, int128(0));

        PoolId id = key.toId();
        PoolConfig storage c = config[id];
        if (!c.registered) return (IHooks.afterSwap.selector, int128(0));

        // [A4/B1] EXACT-INPUT ONLY.
        if (params.amountSpecified >= 0) return (IHooks.afterSwap.selector, int128(0));

        // zeroForOne == spend quote(currency0) → get token(currency1) == a BUY. Output leg = currency1.
        bool isBuy = params.zeroForOne;
        uint256 uc = isBuy ? 1 : 0;
        uint16 rate = isBuy ? c.buyTaxBps : c.sellTaxBps;
        if (rate == 0) return (IHooks.afterSwap.selector, int128(0));

        int128 ucAmt = uc == 0 ? delta.amount0() : delta.amount1();
        uint256 mag = ucAmt > 0 ? uint256(uint128(ucAmt)) : uint256(uint128(-ucAmt));
        if (mag == 0) return (IHooks.afterSwap.selector, int128(0));

        uint256 fee = (mag * rate) / BPS;
        if (fee == 0) return (IHooks.afterSwap.selector, int128(0));
        if (fee > uint256(uint128(MAX_SKIM))) fee = uint256(uint128(MAX_SKIM));

        Currency ucCurrency = uc == 0 ? key.currency0 : key.currency1;

        // [D2] Guard the take. A blocklisted/paused fee currency must NOT brick the swap.
        try poolManager.take(ucCurrency, address(this), fee) {}
        catch {
            emit SkimSkipped(id, uc, fee);
            return (IHooks.afterSwap.selector, int128(0));
        }

        if (isBuy) {
            // buy → platform (token leg)
            platformOwed[id][uc] += fee;
            emit BuyTaxed(id, fee);
        } else {
            // sell → creator + floor (quote leg); subtraction conserves dust into the creator's cut
            uint256 floorCut = (fee * c.sellFloorShareBps) / BPS;
            uint256 creatorCut = fee - floorCut;
            creatorOwed[id][uc] += creatorCut;
            floorOwed[id][uc] += floorCut;
            emit SellTaxed(id, creatorCut, floorCut);
        }

        // Return the +fee delta LAST (CEI). Nets the -fee from `take` → unlock closes clean. [A3]
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
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
    function claimCreator(PoolId id, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        amount = creatorOwed[id][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        creatorOwed[id][currencyIndex] = 0;
        address to = config[id].creator;
        _payout(_currencyAt(id, currencyIndex), to, amount);
        emit CreatorClaimed(id, currencyIndex, to, amount);
    }

    /// @notice Forward the accrued floor carve for one currency to the pool's floor recipient
    /// (the floor vault / keeper). Permissionless; funds always go to the registered recipient.
    function claimFloor(PoolId id, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        address to = config[id].floorRecipient;
        if (to == address(0)) revert NoFloorRecipient();
        amount = floorOwed[id][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        floorOwed[id][currencyIndex] = 0;
        _payout(_currencyAt(id, currencyIndex), to, amount);
        emit FloorClaimed(id, currencyIndex, to, amount);
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

    /// @dev Native → low-level call; ERC20 → CurrencyLibrary.transfer (reverts on failure). Callers
    /// zero the owed slot before calling under nonReentrant; a failed send reverts the whole claim and
    /// restores the slot — funds are never lost, and the failure is isolated to that one caller/currency.
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
