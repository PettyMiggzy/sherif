// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from
    "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {ITrollSplitter} from "./interfaces/ITrollSplitter.sol";

/// @dev The two getters bootstrapFactory checks; an interface rather than
/// importing TrollPadFactory, which imports this contract.
interface IFactoryWiring {
    function hook() external view returns (address);
    function poolManager() external view returns (address);
}

/// @notice ONE shared hook contract, used by every Troll Pad launch's pool
/// — including every white-label pad deployed through TrollPadFactory, not
/// just the original Troll Pad. Every launch is a real Uniswap v4 pool from
/// block one (no bonding curve, no graduation — see TrollPortal), and this
/// hook taxes every swap on every one of those pools. Deliberately a
/// singleton instead of one hook per launch (or per pad) — see the
/// `bootstrapMainPortal`/`bootstrapFactory`/`authorizePortal` trio below for
/// why one shared, pre-mined address can serve every pad's launches.
///
/// Tax is ALWAYS denominated in the pool's quote asset, regardless of swap
/// shape (audit finding H-1: the previous version taxed whichever currency
/// was "unspecified", which meant every exact-input buy — what every router
/// sends by default — was taxed in the launch token instead of quote,
/// handing the creator a claimable, dumpable cut of the supply on every
/// single buy):
///   - quote is the swap's SPECIFIED leg (exact-in buy, exact-out sell)
///     -> taken in `beforeSwap`, via the returned `BeforeSwapDelta`'s
///     specified-side component (same mechanism Uniswap's own fee-hook
///     references use to shrink the amount that reaches the pool).
///   - quote is the swap's UNSPECIFIED leg (exact-in sell, exact-out buy)
///     -> taken in `afterSwap`, from the realized swap delta, same as
///     before.
/// Exactly one of the two branches fires per swap (see the
/// `specifiedIsCurrency0 == quoteIsCurrency0` check duplicated, inverted,
/// in each), so every swap shape is taxed exactly once, always in quote.
///
/// Tax is never transferred to anyone during a swap (audit finding H-2: the
/// old version pushed the tax to the splitter, which pushed the platform's
/// cut on to the treasury, inside the swap itself — a single blocklisted
/// address anywhere in that chain, e.g. Circle blocklisting the treasury,
/// would have permanently reverted every swap on every pool forever, since
/// PoolConfig is immutable and there is no way to route around a stuck
/// recipient mid-swap). Instead, tax is minted to this contract as ERC-6909
/// claims on the PoolManager (`IPoolManager.mint`, offset by the same
/// `AFTER_SWAP_RETURNS_DELTA`/`BEFORE_SWAP_RETURNS_DELTA`-gated hookDelta
/// mechanism that already made the old take()-based version's accounting
/// net to zero — see `PoolManager.swap`'s `_accountPoolBalanceDelta` calls),
/// tracked per pool in `pendingTax`, and paid out through a permissionless
/// `flush(key)` anyone can call at any time. A failing recipient there can
/// only ever block that one `flush` call, never a swap.
///
/// Required address flags — mine for exactly these (value `0x28CC`):
///   BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | AFTER_SWAP |
///   BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA
/// `BEFORE_INITIALIZE` closes a separate griefing vector (audit finding
/// H-3): a launch's token address is predictable ahead of time (the
/// Portal's own CREATE nonce), so without this gate anyone could front-run
/// `createLaunch` by initializing that exact pool key themselves first,
/// permanently blocking the real launch with `PoolAlreadyInitialized`.
/// `BEFORE_ADD_LIQUIDITY` (2026-09-24 audit, hook-1) restricts liquidity on
/// a launch pool to that launch's own locker. Without it anyone could place
/// a token-only or USDC-only range just past the price — a limit order that
/// other people's swaps fill — and trade with no tax at all, while also
/// taking a cut of the LP fees.
contract TrollHook is IHooks, IUnlockCallback {
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;

    struct PoolConfig {
        address splitter; // where this launch's tax revenue goes
        address quoteAsset;
        bool tokenIsToken0;
        uint16 buyTaxBps; // creator-set at launch, immutable after
        uint16 sellTaxBps;
        bool active;
        // Last, so the poolConfigs getter's first six fields keep their
        // positions for existing readers (web app, SDK).
        address locker; // the only address allowed to add liquidity to this pool
    }

    uint16 public constant MAX_TAX_BPS = 1_000; // 10% per side — mirrors TrollPortal.MAX_TAX_BPS (defense in depth)

    address public immutable poolManager;
    // Not immutable: the hook must be deployed (mined to a valid flag
    // address) before a Portal can be constructed with the hook's address,
    // so the hook can't know any Portal's address at its own construction
    // time — a genuine circular dependency. Resolved with two one-time
    // bootstrap calls instead of a fragile address-prediction dance, both
    // restricted to the `bootstrapper` address passed into the constructor:
    //   - `bootstrapMainPortal`: wires up Troll Pad's own, original Portal.
    //   - `bootstrapFactory`: wires up the ONE trusted TrollPadFactory,
    //     which can then authorize as many more portals as it deploys
    //     (each is a paying customer's own white-label pad) via
    //     `authorizePortal`, forever, permissionlessly, with zero further
    //     admin calls ever needed.
    // Every authorized portal — the main one and every factory-deployed
    // one — shares this SAME hook and reports pool tax revenue through
    // whichever splitter that specific launch was deployed with; nothing
    // about a "white-label" pad is actually separate contract logic, only
    // separate Portal instances and separate branding on top.
    //
    // Passed in explicitly, NOT captured as msg.sender at construction
    // (audit finding D-1): this hook is deployed via a salted `new
    // TrollHook{salt: salt}(...)` so its address lands on the required flag
    // bits, and Foundry (and any other CREATE2-aware deploy tooling)
    // broadcasts a salted deploy THROUGH the shared, unowned CREATE2 factory
    // (0x4e59b844...) rather than directly from the broadcaster's EOA.
    // msg.sender inside this constructor would therefore be that factory,
    // not whoever is actually running the deploy — capturing it here would
    // have permanently bricked bootstrapMainPortal/bootstrapFactory, since
    // nobody holds a key for the shared factory's address.
    address private immutable bootstrapper;
    bool public mainPortalBootstrapped;
    address public factory;
    bool public factoryBootstrapped;
    mapping(address => bool) public isAuthorizedPortal;

    mapping(bytes32 => PoolConfig) public poolConfigs;
    /// @notice The authorized portal that initialized each pool. Only that
    /// portal may register it — an authorized portal can't claim a pool
    /// someone else initialized (2026-09-24 audit, factory-trust-1).
    mapping(bytes32 => address) public initializer;
    /// @notice Tax accrued per pool, in quote units, held as ERC-6909
    /// claims on the PoolManager until `flush` pays it out.
    mapping(bytes32 => uint256) public pendingTax;

    error NotPoolManager();
    error NotAuthorizedPortal();
    error AlreadyRegistered();
    error NotBootstrapper();
    error NotFactory();
    error ZeroAddress();
    error AlreadyBootstrapped();
    error WrongHook();
    error QuoteMismatch();
    error NativeQuoteUnsupported();
    error TaxTooHigh();
    error UnknownPool();
    error NothingToFlush();
    error NotInitializer();
    error LiquidityLocked();
    error PartialFillUnsupported();
    error NoLiquidityToFill();
    error InvalidFactory();

    event PoolRegistered(
        bytes32 indexed poolId,
        address indexed splitter,
        address indexed quoteAsset,
        bool tokenIsToken0,
        uint16 buyTaxBps,
        uint16 sellTaxBps
    );
    event TaxCollected(bytes32 indexed poolId, address indexed quoteAsset, bool isBuy, uint256 amount);
    event TaxFlushed(bytes32 indexed poolId, address indexed quoteAsset, address indexed splitter, uint256 amount, address caller);
    event PortalAuthorized(address indexed portal);
    event FactoryBootstrapped(address indexed factory);
    event FactoryBootstrapRenounced();

    modifier onlyPoolManager() {
        if (msg.sender != poolManager) revert NotPoolManager();
        _;
    }

    constructor(address poolManager_, address bootstrapper_) {
        if (bootstrapper_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        bootstrapper = bootstrapper_;
    }

    /// @notice Wires up Troll Pad's own original Portal. Callable exactly
    /// once, only by the address named `bootstrapper` at construction.
    function bootstrapMainPortal(address portal_) external {
        if (msg.sender != bootstrapper) revert NotBootstrapper();
        if (mainPortalBootstrapped) revert AlreadyBootstrapped();
        mainPortalBootstrapped = true;
        isAuthorizedPortal[portal_] = true;
        emit PortalAuthorized(portal_);
    }

    /// @notice Wires up the one trusted TrollPadFactory. Callable exactly
    /// once, only by the address named `bootstrapper` at construction. The
    /// factory must be a deployed contract wired to this hook and this
    /// PoolManager — the slot is one-shot, so a typo or a factory built for
    /// another hook would otherwise disable white-label pads for good
    /// (2026-09-24 audit, factory-trust-2).
    function bootstrapFactory(address factory_) external {
        if (msg.sender != bootstrapper) revert NotBootstrapper();
        if (factoryBootstrapped) revert AlreadyBootstrapped();
        if (factory_.code.length == 0) revert InvalidFactory();
        if (IFactoryWiring(factory_).hook() != address(this) || IFactoryWiring(factory_).poolManager() != poolManager) {
            revert InvalidFactory();
        }
        factoryBootstrapped = true;
        factory = factory_;
        emit FactoryBootstrapped(factory_);
    }

    /// @notice Permanently closes the factory slot without naming a
    /// factory. Until either this or `bootstrapFactory` is called, whoever
    /// holds the bootstrapper key could name any contract as the factory
    /// and use it to authorize arbitrary portals (2026-09-24 audit,
    /// factory-trust-1). Call this at deploy time if white-label pads
    /// aren't wanted yet.
    function renounceFactoryBootstrap() external {
        if (msg.sender != bootstrapper) revert NotBootstrapper();
        if (factoryBootstrapped) revert AlreadyBootstrapped();
        factoryBootstrapped = true;
        emit FactoryBootstrapRenounced();
    }

    /// @notice Called by the factory the moment it deploys a new
    /// white-label Portal for a paying customer. Nothing else may call it.
    function authorizePortal(address portal_) external {
        if (msg.sender != factory) revert NotFactory();
        isAuthorizedPortal[portal_] = true;
        emit PortalAuthorized(portal_);
    }

    /// @notice Called once, by the authorized portal that just initialized
    /// the pool, in the same transaction it creates the launch — and before
    /// the locker seeds liquidity, since only the registered locker may add
    /// any. Validates the key actually points at this hook and at the
    /// claimed quote asset (audit finding L-2).
    function registerPool(
        PoolKey calldata key,
        address splitter,
        address locker,
        address quoteAsset,
        bool tokenIsToken0,
        uint16 buyTaxBps,
        uint16 sellTaxBps
    ) external {
        if (!isAuthorizedPortal[msg.sender]) revert NotAuthorizedPortal();
        if (address(key.hooks) != address(this)) revert WrongHook();
        if (buyTaxBps > MAX_TAX_BPS || sellTaxBps > MAX_TAX_BPS) revert TaxTooHigh();
        if (quoteAsset == address(0)) revert NativeQuoteUnsupported();
        if (splitter == address(0) || locker == address(0)) revert ZeroAddress();
        address keyQuote = Currency.unwrap(tokenIsToken0 ? key.currency1 : key.currency0);
        if (keyQuote != quoteAsset) revert QuoteMismatch();

        bytes32 id = PoolId.unwrap(key.toId());
        if (initializer[id] != msg.sender) revert NotInitializer();
        if (poolConfigs[id].active) revert AlreadyRegistered();
        poolConfigs[id] = PoolConfig({
            splitter: splitter,
            quoteAsset: quoteAsset,
            tokenIsToken0: tokenIsToken0,
            buyTaxBps: buyTaxBps,
            sellTaxBps: sellTaxBps,
            active: true,
            locker: locker
        });
        emit PoolRegistered(id, splitter, quoteAsset, tokenIsToken0, buyTaxBps, sellTaxBps);
    }

    /// @notice Pays a pool's accrued tax to its splitter. Anyone may call —
    /// there is no keeper, no automated trigger; a cron job on any machine
    /// (or a curious trader) calling this periodically is the whole
    /// mechanism. See the contract-level note on why this is pull-based
    /// (audit finding H-2).
    function flush(PoolKey calldata key) external {
        bytes32 id = PoolId.unwrap(key.toId());
        PoolConfig memory cfg = poolConfigs[id];
        if (!cfg.active) revert UnknownPool();
        uint256 amount = pendingTax[id];
        if (amount == 0) revert NothingToFlush();
        pendingTax[id] = 0;

        Currency quote = Currency.wrap(cfg.quoteAsset);
        IPoolManager(poolManager).unlock(abi.encode(quote, cfg.splitter, amount));
        ITrollSplitter(cfg.splitter).depositRevenue(cfg.quoteAsset, amount);
        emit TaxFlushed(id, cfg.quoteAsset, cfg.splitter, amount, msg.sender);
    }

    /// @dev Burns this contract's own ERC-6909 claim (minted during swaps by
    /// `_accrue`) and takes the real underlying token straight to the
    /// splitter, in the same unlock — no intermediate hop through this
    /// contract's own ERC-20 balance is needed.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Currency currency, address to, uint256 amount) = abi.decode(data, (Currency, address, uint256));
        IPoolManager(poolManager).burn(address(this), currency.toId(), amount);
        IPoolManager(poolManager).take(currency, to, amount);
        return "";
    }

    // ------------------------------------------------------------------
    // IHooks
    // ------------------------------------------------------------------

    /// @dev Gate: only an authorized portal may initialize a pool that uses
    /// this hook. Closes the pre-initialize griefing vector on
    /// `createLaunch` (audit finding H-3) — without this, anyone can
    /// predict a launch's token address ahead of time and initialize that
    /// exact pool key first, permanently blocking the real launch.
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external onlyPoolManager returns (bytes4) {
        if (!isAuthorizedPortal[sender]) revert NotAuthorizedPortal();
        initializer[PoolId.unwrap(key.toId())] = sender;
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    /// @dev Only the launch's own locker may add liquidity (see the
    /// contract-level note on hook-1). An unregistered pool has no locker,
    /// so nothing can be added to it at all — the portal registers the pool
    /// before its locker seeds. Removing liquidity isn't gated: with adds
    /// restricted, the locker's position is the only one that can exist,
    /// and the locker itself never removes.
    function beforeAddLiquidity(address sender, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        PoolConfig storage cfg = poolConfigs[PoolId.unwrap(key.toId())];
        if (!cfg.active || sender != cfg.locker) revert LiquidityLocked();
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.afterDonate.selector;
    }

    /// @dev Handles swaps where QUOTE is the SPECIFIED leg (exact-in buy,
    /// exact-out sell). Returning a positive specified-side delta shrinks
    /// the amount that actually reaches the pool's swap math by `taxAmount`
    /// (see `Hooks.beforeSwap`'s `amountToSwap += hookDeltaSpecified`), while
    /// `PoolManager.swap`'s later `_accountPoolBalanceDelta` call credits
    /// that same `taxAmount` back to this contract's account — netting out
    /// the debt `_accrue`'s `mint` call created, and leaving the swapper's
    /// own accounted delta unchanged (they still pay/receive exactly the
    /// amount they specified; the tax comes out of what the pool itself
    /// receives). Requires `BEFORE_SWAP_RETURNS_DELTA` — without it this
    /// returned delta is silently ignored by the PoolManager.
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bytes32 id = PoolId.unwrap(key.toId());
        PoolConfig memory cfg = poolConfigs[id];
        if (!cfg.active) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        bool quoteIsCurrency0 = !cfg.tokenIsToken0;
        if (specifiedIsCurrency0 != quoteIsCurrency0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0); // quote is unspecified; afterSwap handles it
        }

        bool isBuy = params.zeroForOne != cfg.tokenIsToken0;
        uint16 taxBps = isBuy ? cfg.buyTaxBps : cfg.sellTaxBps;
        if (taxBps == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 taxAmount = _specifiedTax(params.amountSpecified, taxBps);
        if (taxAmount == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        _accrue(id, cfg.quoteAsset, quoteIsCurrency0 ? key.currency0 : key.currency1, isBuy, taxAmount);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(taxAmount.toInt128(), 0), 0);
    }

    /// @dev Handles swaps where QUOTE is the UNSPECIFIED leg (exact-in
    /// sell, exact-out buy) — the FeeTakingHook pattern this hook already
    /// used before the audit, now gated to only fire for this half of the
    /// swap-shape matrix (the other half is `beforeSwap`'s job).
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        bytes32 id = PoolId.unwrap(key.toId());
        PoolConfig memory cfg = poolConfigs[id];
        if (!cfg.active) return (IHooks.afterSwap.selector, 0);

        // A swap that filled nothing only moved the price across empty
        // ticks — free, repeatable, and what let anyone push a fresh launch
        // to an absurd price (2026-09-24 audit, portal-1).
        if (delta.amount0() == 0 && delta.amount1() == 0) revert NoLiquidityToFill();

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        bool quoteIsCurrency0 = !cfg.tokenIsToken0;
        bool isBuy = params.zeroForOne != cfg.tokenIsToken0;
        uint16 taxBps = isBuy ? cfg.buyTaxBps : cfg.sellTaxBps;
        if (taxBps == 0) return (IHooks.afterSwap.selector, 0);

        if (specifiedIsCurrency0 == quoteIsCurrency0) {
            // Quote was the specified leg: beforeSwap already charged tax on
            // the full requested amount, so the swap must have filled in
            // full. A price limit or a liquidity edge that stops it early
            // would otherwise tax the unfilled part too (audit hook-2).
            // Full fill means the pool's specified-leg delta equals the
            // amount actually handed to the swap: amountSpecified + tax.
            uint256 charged = _specifiedTax(params.amountSpecified, taxBps);
            if (charged != 0) {
                int128 specifiedDelta = specifiedIsCurrency0 ? delta.amount0() : delta.amount1();
                if (int256(specifiedDelta) != params.amountSpecified + int256(charged)) revert PartialFillUnsupported();
            }
            return (IHooks.afterSwap.selector, 0);
        }

        int128 unspecifiedAmount = specifiedIsCurrency0 ? delta.amount1() : delta.amount0();
        uint256 base = unspecifiedAmount < 0 ? uint256(uint128(-unspecifiedAmount)) : uint256(uint128(unspecifiedAmount));
        // Exact-in sell: `base` is the gross USDC out, tax is a share of it.
        // Exact-out buy: `base` is the net USDC the pool keeps and the buyer
        // pays base + tax, so tax is grossed up to the same share of the
        // total (audit hook-3).
        uint256 taxAmount = params.amountSpecified < 0 ? (base * taxBps) / 10_000 : _grossUp(base, taxBps);
        if (taxAmount == 0) return (IHooks.afterSwap.selector, 0);

        _accrue(id, cfg.quoteAsset, quoteIsCurrency0 ? key.currency0 : key.currency1, isBuy, taxAmount);
        return (IHooks.afterSwap.selector, taxAmount.toInt128());
    }

    /// @dev Tax on the specified (quote) leg. Exact input (amountSpecified <
    /// 0): a share of the gross amount sent. Exact output: the seller
    /// receives `amountSpecified` net and the pool pays out that plus tax, so
    /// tax is grossed up to the same share of the total (audit hook-3 —
    /// previously exact-output shapes paid t/(1+t), e.g. 9.09% for 10%).
    function _specifiedTax(int256 amountSpecified, uint16 taxBps) internal pure returns (uint256) {
        if (amountSpecified < 0) return (uint256(-amountSpecified) * taxBps) / 10_000;
        return _grossUp(uint256(amountSpecified), taxBps);
    }

    /// @dev ceil(net * bps / (10000 - bps)): the tax that makes tax/(net+tax) == bps/10000.
    function _grossUp(uint256 net, uint16 taxBps) internal pure returns (uint256) {
        uint256 denom = 10_000 - taxBps;
        return (net * taxBps + denom - 1) / denom;
    }

    /// @dev Mints `amount` of `quote` to this contract as an ERC-6909
    /// claim — the debt this creates against this contract's own account is
    /// paid back to zero by the `hookDelta` the caller (`beforeSwap` or
    /// `afterSwap`) returns in the same call, exactly the way the old
    /// `take()`-based version's debt was paid back (see contract-level
    /// note). Tracked in `pendingTax` for `flush` to pay out later.
    function _accrue(bytes32 id, address quoteAsset, Currency quote, bool isBuy, uint256 amount) internal {
        IPoolManager(poolManager).mint(address(this), quote.toId(), amount);
        pendingTax[id] += amount;
        emit TaxCollected(id, quoteAsset, isBuy, amount);
    }
}
