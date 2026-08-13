// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";

import {BaseHook} from "./BaseHook.sol";
import {IFeeWalletRegistry, IStockGuardAdapter, IRobinFeeHookAdmin} from "../interfaces/IRobinInterfaces.sol";

/// @title RobinFeeHook — directional trade-tax engine (the heart of Robin V4)
/// @notice Both trade taxes are denominated in the MONEY SIDE (currency0: ETH on a curve/ETH pad, or the
/// stock ERC20 on a stock pad) — NEVER the pad coin — and routed by DIRECTION:
///
///   • BUY  (money → token, `zeroForOne`): `buyTaxBps` skimmed FEE-ON-INPUT in beforeSwap — a slice of the
///          money the buyer spends, taken before the pool swaps the rest. Splits into a `buyBufferShareBps`
///          curve buffer (ETH support held by the curve → platform at graduation) + a `referralShareBps`
///          referrer slice (from the platform cut, when a ref link is used) + the platform.
///   • SELL (token → money, `oneForZero`): `sellTaxBps` of the money-side OUTPUT in afterSwap → creator,
///          minus a `sellFloorShareBps` carve that funds the pad's permanent price FLOOR.
///
/// Holders are rewarded separately, by staking (RobinLockStaking / DualStaking). All payouts are
/// accrue-and-pull: nothing is pushed to an external wallet inside a swap, so a reverting recipient can
/// never block trading.
///
/// Red-team invariants preserved from the spine:
///   [A1] The tax is always ADDITIONAL (the hook owns no position to carve from). Buy fee is minted as an
///        ERC-6909 claim on the input leg (settled by the buyer's input); sell fee is taken from the output leg.
///   [A2] The pool uses a STATIC lp fee; beforeSwap never overrides it (only the stock curb lives there).
///   [A4/B1] Tax is EXACT-INPUT ONLY; the buy fee-on-input is collected via `mint` (pure accounting — NEVER fronts
///           the singleton's reserves, so it can't revert on a cold pool) + a positive specified BeforeSwapDelta;
///           the sell fee via a `take` of the just-produced output (already held by the PoolManager) + the afterSwap
///           return delta. Neither fronts foreign reserves. Exact-output is rejected on registered pads.
///   [D2] The sell `take` and every claim-time `take` is try/caught / retriable — a blocklisted/paused stock fee
///        currency skips or defers, never bricks trading; the buy `mint` likewise can't brick a buy.
///   [G1] REQUIRED_FLAGS == 0x00CC, self-asserted in the ctor and cross-checked by the factory.
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
    /// @dev The pad token this hook was minted for. Included in the ctor so each pad's hook init-code
    /// (and therefore its mined CREATE2 address) is UNIQUE — otherwise every launch from a factory would
    /// build byte-identical init-code and the second launch would collide on AlreadyDeployed. [audit]
    address public immutable pad;

    struct PoolConfig {
        bool registered;
        bool quoteIsStock;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 sellFloorShareBps; // share of the sell tax carved to the floor
        uint16 buyBufferShareBps; // share of the buy tax kept as a curve buffer (rest → platform)
        uint16 referralShareBps; // share of the platform buy cut paid to a referrer (rest → platform)
        uint32 guardWindow;
        Currency currency0; // quote
        Currency currency1; // token
        address creator; // 2-step repointable by the creator only
        address pendingCreator;
        address floorRecipient; // where claimFloor forwards; 0 => floor parks in floorOwed
        address bufferRecipient; // where claimBuffer forwards (the curve → permanent LP); 0 => parks in bufferOwed
        address guardAdapter; // stock guard; 0 => no curb
    }

    mapping(PoolId => PoolConfig) public config;

    // Accrue-and-pull books. currencyIndex ∈ {0 = money side (quote/ETH), 1 = token}. Both taxes are
    // money-side, so live entries sit at index 0; index 1 is retained only for the generic claim signature.
    mapping(PoolId => mapping(uint256 => uint256)) public platformOwed; // from buys (money side)
    mapping(PoolId => mapping(uint256 => uint256)) public creatorOwed; // from sells (money side)
    mapping(PoolId => mapping(uint256 => uint256)) public floorOwed; // carve from sells (money side)
    mapping(PoolId => uint256) public bufferOwed; // curve-buffer carve from buys (money side) → forwarded to the curve
    // referral carve from buys (money side): the referrer (passed in swap hookData) earns a slice of the platform's
    // buy cut. Keyed by referrer → money-side currency (address(0) for ETH), so one claim sweeps every ETH pad.
    mapping(address referrer => mapping(address quote => uint256)) public referralOwed;

    event PoolRegistered(PoolId indexed id, address indexed creator, uint16 buyTaxBps, uint16 sellTaxBps);
    event BuyTaxed(PoolId indexed id, uint256 platformCut, uint256 bufferCut); // money side
    event SellTaxed(PoolId indexed id, uint256 creatorCut, uint256 floorCut); // money side
    event SkimSkipped(PoolId indexed id, uint256 currencyIndex, uint256 fee);
    event PlatformClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event CreatorClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event FloorClaimed(PoolId indexed id, uint256 currencyIndex, address to, uint256 amount);
    event BufferClaimed(PoolId indexed id, address to, uint256 amount);
    event ReferralAccrued(PoolId indexed id, address indexed referrer, address quote, uint256 amount);
    event ReferralClaimed(address indexed referrer, address indexed quote, uint256 amount);
    event CreatorRepointStarted(PoolId indexed id, address pending);
    event CreatorRepointed(PoolId indexed id, address creator);

    error NotFactory();
    error AlreadyRegistered();
    error NotRegistered();
    error BadTax();
    error BadShares();
    error NotCreator();
    error NotPlatform();
    error FloorRecipientAlreadySet();
    error BufferRecipientAlreadySet();
    error ZeroAddress();
    error NoFloorRecipient();
    error NoBufferRecipient();
    error NothingToClaim();
    error PayoutFailed();
    error CorporateActionCurb();
    error ExactOutputNotSupported();

    event FloorRecipientSet(PoolId indexed id, address recipient);
    event BufferRecipientSet(PoolId indexed id, address recipient);

    constructor(IPoolManager _pm, address _factory, IFeeWalletRegistry _feeRegistry, address _padToken) BaseHook(_pm) {
        if (_factory == address(0) || address(_feeRegistry) == address(0) || _padToken == address(0)) revert ZeroAddress();
        factory = _factory;
        feeRegistry = _feeRegistry;
        pad = _padToken;
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
        if (cfg.buyBufferShareBps > BPS) revert BadShares();
        if (cfg.referralShareBps > BPS) revert BadShares(); // ≤100% of the platform buy cut (FeeConfig caps tighter)

        config[id] = PoolConfig({
            registered: true,
            quoteIsStock: cfg.quoteIsStock,
            buyTaxBps: cfg.buyTaxBps,
            sellTaxBps: cfg.sellTaxBps,
            sellFloorShareBps: cfg.sellFloorShareBps,
            buyBufferShareBps: cfg.buyBufferShareBps,
            referralShareBps: cfg.referralShareBps,
            guardWindow: cfg.guardWindow,
            currency0: cfg.currency0,
            currency1: cfg.currency1,
            creator: cfg.creator,
            pendingCreator: address(0),
            floorRecipient: cfg.floorRecipient,
            bufferRecipient: address(0),
            guardAdapter: cfg.guardAdapter
        });
        emit PoolRegistered(id, cfg.creator, cfg.buyTaxBps, cfg.sellTaxBps);
    }

    // --------------------------------------------------------------------- //
    //                              beforeSwap                               //
    // --------------------------------------------------------------------- //

    /// @notice Three jobs: (1) take the BUY tax as a FEE-ON-INPUT — a slice of the money-side (currency0: ETH, or
    /// the stock on a stock pad) the buyer spends, so the buy fee is denominated in the MONEY SIDE, not the coin.
    /// The remaining input is what the pool actually swaps (returned as a positive specified BeforeSwapDelta).
    /// The fee is collected as an ERC-6909 CLAIM via `poolManager.mint` (NOT `take`): the buyer's input is not yet
    /// settled at beforeSwap time, so a physical `take` would front the singleton's aggregate reserves and could
    /// revert on a cold pool — dropping the whole tax. `mint` is pure accounting (no transfer), so the buy tax is
    /// always collected regardless of singleton depth; the claim is redeemed for real currency at claim time (when
    /// the singleton is warm) by `_pullClaimsAndPay`. (2) [audit H1] REJECT exact-output swaps on registered pads,
    /// so the tax can't be dodged. (3) the stock corporate-action curb [D4]; the adapter read is try/caught so a
    /// broken adapter can't freeze trading.
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        override
        onlyPoolManager
        nonReentrant
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolConfig storage c = config[id];
        // exact-input == amountSpecified < 0; anything else (exact-output) is untaxable → reject on pads.
        if (c.registered && params.amountSpecified >= 0) revert ExactOutputNotSupported();
        if (c.guardWindow > 0 && c.quoteIsStock && c.guardAdapter != address(0)) {
            uint256 ea = _scheduledEffectiveAt(c.guardAdapter);
            if (ea != 0) {
                uint256 nowTs = block.timestamp;
                uint256 diff = nowTs > ea ? nowTs - ea : ea - nowTs;
                if (diff <= c.guardWindow) revert CorporateActionCurb();
            }
        }

        // BUY tax = fee on the money-side INPUT. zeroForOne spends currency0 (the quote) → a BUY. Sells (oneForZero)
        // are taxed in afterSwap from the money-side OUTPUT. Skip: unregistered, the hook's own swaps, sells, rate 0.
        if (!c.registered || sender == address(this) || !params.zeroForOne || c.buyTaxBps == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        // fee on the REQUESTED exact-input. NOTE: if the buyer sets a restrictive sqrtPriceLimit and the swap only
        // partially fills, the fee still tracks the requested amount (the executed amount is unknown until after the
        // swap, and only beforeSwap can adjust the specified/input leg). This is settlement-safe and by design — a
        // buyer should size their input, not rely on a partial-fill price limit to reduce the tax. [audit LOW]
        uint256 fee = (uint256(-params.amountSpecified) * c.buyTaxBps) / BPS;
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        if (fee > uint256(uint128(MAX_SKIM))) fee = uint256(uint128(MAX_SKIM));

        // Collect the fee as an ERC-6909 CLAIM (pure accounting: no physical transfer, so it never fronts the
        // singleton's reserves and never reverts on a cold pool). [D2] still try/caught for defense-in-depth: if the
        // mint ever reverts, skip the skim rather than brick the buy. Redeemed for real currency0 at claim time.
        try poolManager.mint(address(this), key.currency0.toId(), fee) {}
        catch {
            emit SkimSkipped(id, 0, fee);
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        _bookBuy(id, c, key.currency0, fee, hookData);
        // positive specified delta = the hook consumed `fee` of the input; the pool swaps (input − fee).
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), int128(0)), 0);
    }

    /// @dev Book a buy tax (money-side currency0) → curve buffer + referrer + platform. Buffer first, then a referrer
    /// from hookData earns a slice of the PLATFORM cut, platform takes the rest. Subtraction conserves dust → platform.
    /// @dev [audit] The referral carve is PERMISSIONLESS BY DESIGN: whoever the swap's hookData names — including the
    /// buyer themselves, or a Sybil alt-wallet — earns `referralShareBps` of the platform cut. On-chain attribution
    /// of a *genuine external* referrer is impossible (the hook sees the router as `sender`, not the buyer, and a
    /// buyer can always route through a fresh address), so a `referrer != sender` guard would be theatre. The carve is
    /// therefore an at-most-`referralShareBps` REBATE on the platform's own buy cut: it never touches the buffer,
    /// the trader's proceeds, the raise, or any other pad's funds (conservation holds — see the self-referral sim),
    /// and it only ever lowers the PLATFORM's own take. If strict external-only attribution is ever required it must
    /// be enforced OFF-CHAIN (platform-signed referral codes verified here), which is a deliberate future change.
    function _bookBuy(PoolId id, PoolConfig storage c, Currency quote, uint256 fee, bytes calldata hookData) internal {
        uint256 bufferCut = (fee * c.buyBufferShareBps) / BPS;
        uint256 platformCut = fee - bufferCut;
        bufferOwed[id] += bufferCut;
        uint256 referralCut = 0;
        if (c.referralShareBps != 0) {
            address referrer = _decodeReferrer(hookData);
            if (referrer != address(0)) {
                referralCut = (platformCut * c.referralShareBps) / BPS;
                if (referralCut != 0) {
                    address q = Currency.unwrap(quote);
                    referralOwed[referrer][q] += referralCut;
                    emit ReferralAccrued(id, referrer, q, referralCut);
                }
            }
        }
        platformOwed[id][0] += platformCut - referralCut; // index 0 = the money side (quote)
        emit BuyTaxed(id, platformCut - referralCut, bufferCut);
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

    /// @notice SELL tax = a slice of the money-side OUTPUT (currency0: ETH/stock the seller receives) → creator +
    /// floor. Buys are taxed in beforeSwap (fee-on-input), so afterSwap is SELLS ONLY. Exact-input only; the take is
    /// guarded so a blocklisted quote can't brick the sell.
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
        // [audit] Exempt the pad's OWN curve controller: its token→ETH swaps (graduation ceiling nudge,
        // restoreCeiling anti-grief) are protocol plumbing, not trades — taxing them would siphon the raise and
        // under-refund an honest ceiling restorer. The curve is the registered bufferRecipient (a known address).
        if (sender == c.bufferRecipient && c.bufferRecipient != address(0)) return (IHooks.afterSwap.selector, int128(0));
        if (params.amountSpecified >= 0) return (IHooks.afterSwap.selector, int128(0)); // [A4/B1] exact-input only
        if (params.zeroForOne) return (IHooks.afterSwap.selector, int128(0)); // BUYS are taxed in beforeSwap
        if (c.sellTaxBps == 0) return (IHooks.afterSwap.selector, int128(0));

        // sell output = the money side (currency0); take sellTax% of it → creator + floor
        int128 outAmt = delta.amount0();
        uint256 mag = outAmt > 0 ? uint256(uint128(outAmt)) : 0;
        if (mag == 0) return (IHooks.afterSwap.selector, int128(0));
        uint256 fee = (mag * c.sellTaxBps) / BPS;
        if (fee == 0) return (IHooks.afterSwap.selector, int128(0));
        if (fee > uint256(uint128(MAX_SKIM))) fee = uint256(uint128(MAX_SKIM));

        // [D2] Guard the take. A blocklisted/paused fee currency must NOT brick the swap.
        try poolManager.take(key.currency0, address(this), fee) {}
        catch {
            emit SkimSkipped(id, 0, fee);
            return (IHooks.afterSwap.selector, int128(0));
        }
        uint256 floorCut = (fee * c.sellFloorShareBps) / BPS;
        uint256 creatorCut = fee - floorCut; // dust conserved into the creator's cut
        creatorOwed[id][0] += creatorCut;
        floorOwed[id][0] += floorCut;
        emit SellTaxed(id, creatorCut, floorCut);
        // Return the +fee delta LAST (CEI). Nets the −fee from `take` → unlock closes clean. [A3]
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    // --------------------------------------------------------------------- //
    //                                claims                                 //
    // --------------------------------------------------------------------- //

    /// @notice Pull the platform's accrued cut for one currency to the timelocked platform wallet.
    /// Permissionless — funds always go to the registry's current wallet, never to the caller. The platform cut is
    /// buy-tax (fee-on-input), held as an ERC-6909 claim, so it is redeemed to real currency via _pullClaimsAndPay.
    function claimPlatform(PoolId id, uint256 currencyIndex) external nonReentrant returns (uint256 amount) {
        amount = platformOwed[id][currencyIndex];
        if (amount == 0) revert NothingToClaim();
        platformOwed[id][currencyIndex] = 0;
        address to = feeRegistry.platformFeeWallet();
        _pullClaimsAndPay(_currencyAt(id, currencyIndex), to, amount);
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

    /// @notice Forward the accrued curve-buffer carve (money side, currency0) to the pool's buffer recipient (the
    /// curve controller), which holds it as curve-phase support and books it to the PLATFORM at graduation.
    /// Permissionless; funds always go to the registered recipient; non-bricking.
    function claimBuffer(PoolId id) external nonReentrant returns (uint256 amount) {
        PoolConfig storage c = config[id];
        address to = c.bufferRecipient;
        if (to == address(0)) revert NoBufferRecipient();
        amount = bufferOwed[id];
        if (amount == 0) revert NothingToClaim();
        bufferOwed[id] = 0;
        _pullClaimsAndPay(c.currency0, to, amount); // money side (ETH/quote); buy-tax claim → real currency
        emit BufferClaimed(id, to, amount);
    }

    /// @notice Pull your accrued referral rewards for one money-side `quote` currency to yourself. Permissionless;
    /// funds only ever go to msg.sender (the referrer). Reward is the MONEY SIDE (ETH → pass address(0); it
    /// aggregates across every ETH pad you referred, so one call sweeps them all).
    function claimReferral(address quote) external nonReentrant returns (uint256 amount) {
        amount = referralOwed[msg.sender][quote];
        if (amount == 0) revert NothingToClaim();
        referralOwed[msg.sender][quote] = 0;
        _pullClaimsAndPay(Currency.wrap(quote), msg.sender, amount); // buy-tax claim → real currency
        emit ReferralClaimed(msg.sender, quote, amount);
    }

    // --------------------------------------------------------------------- //
    //                         creator slot repoint                          //
    // --------------------------------------------------------------------- //

    /// @notice Wire the floor vault for a pool exactly ONCE (from unset), by the platform. The vault
    /// is deployed after the pad (its ctor reads the live pool), so it can't be known at registerPool;
    /// this lets the platform point the carve at it, then it is permanently frozen. Any carve that
    /// parked in `floorOwed` before wiring becomes claimable to the vault afterwards.
    function setFloorRecipient(PoolId id, address recipient) external {
        if (msg.sender != feeRegistry.platformFeeWallet()) revert NotPlatform();
        PoolConfig storage c = config[id];
        if (!c.registered) revert NotRegistered();
        if (c.floorRecipient != address(0)) revert FloorRecipientAlreadySet();
        if (recipient == address(0)) revert ZeroAddress();
        // [M-24] Reject this hook itself. _payout's native branch is a bare call, and this contract has an open
        // receive(), so a self-send would SUCCEED: claimFloor zeroes floorOwed first, the call returns ok, and
        // FloorClaimed is emitted asserting a transfer that moved nothing. The setter is one-shot, so that state
        // is permanent and the hook exposes no rescue. Deliberately NOT a value-transfer probe: on a stock pad
        // the claimed currency can be an ERC-20, and a recipient that cannot take ETH may still be valid.
        if (recipient == address(this)) revert ZeroAddress();
        c.floorRecipient = recipient;
        emit FloorRecipientSet(id, recipient);
    }

    /// @notice Wire the curve-buffer recipient (the pad's curve controller) exactly ONCE, by the FACTORY in the
    /// launch tx (the curve is deployed after registerPool, so it can't be known at registration). Once set it is
    /// permanently frozen; any buffer that parked before wiring becomes claimable to the curve afterwards.
    function setBufferRecipient(PoolId id, address recipient) external {
        if (msg.sender != factory) revert NotFactory();
        PoolConfig storage c = config[id];
        if (!c.registered) revert NotRegistered();
        if (c.bufferRecipient != address(0)) revert BufferRecipientAlreadySet();
        if (recipient == address(0)) revert ZeroAddress();
        c.bufferRecipient = recipient;
        emit BufferRecipientSet(id, recipient);
    }

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

    /// @dev Extract a referrer address from swap hookData WITHOUT ever reverting on malformed data — a bad hookData
    /// must never brick a swap. Reads the low 20 bytes of the first word; empty/short hookData → address(0) (no ref).
    function _decodeReferrer(bytes calldata hookData) internal pure returns (address r) {
        if (hookData.length >= 32) {
            assembly {
                r := and(calldataload(hookData.offset), 0xffffffffffffffffffffffffffffffffffffffff)
            }
        }
    }

    function _currencyAt(PoolId id, uint256 index) internal view returns (Currency) {
        PoolConfig storage c = config[id];
        if (!c.registered) revert NotRegistered();
        return index == 0 ? c.currency0 : c.currency1;
    }

    /// @dev Redeem `amount` of an accrued ERC-6909 CLAIM (how buy-tax fees are held — minted fee-on-input) into
    /// real `currency` and forward it to `to`. Buy fees are minted rather than taken so beforeSwap never fronts the
    /// singleton's reserves; the physical `take` is deferred to here (claim time), when the singleton is warm. The
    /// burn+take run inside our own unlock; a failed take (e.g. a paused stock or cold singleton at claim time)
    /// reverts the whole claim → the owed slot (zeroed by the caller under nonReentrant) is restored → retriable,
    /// never bricked. The recipient send happens AFTER the unlock closes (CEI); nonReentrant blocks re-entry.
    function _pullClaimsAndPay(Currency currency, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        poolManager.unlock(abi.encode(currency, amount)); // burns the claim, takes real `currency` to this hook
        _payout(currency, to, amount);
    }

    /// @dev PoolManager unlock callback: convert this hook's ERC-6909 claim for `currency` into real balance held by
    /// the hook. Only the PoolManager can call it, and only re-enters from our own `_pullClaimsAndPay` unlock.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Currency currency, uint256 amount) = abi.decode(data, (Currency, uint256));
        poolManager.burn(address(this), currency.toId(), amount); // +amount delta (credit the burned claim)
        poolManager.take(currency, address(this), amount); // −amount delta, physical currency → this hook
        return "";
    }

    /// @dev Native → low-level call; ERC20 → CurrencyLibrary.transfer (reverts on failure). Callers
    /// zero the owed slot before calling under nonReentrant; a failed send reverts the whole claim and
    /// restores the slot — funds are never lost, and the failure is isolated to that one caller/currency.
    function _payout(Currency currency, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        // [M-24] defence in depth: no book may ever be settled to this hook. A self-send reports success while
        // moving nothing, and the caller has already zeroed the book by the time we get here.
        if (to == address(this)) revert PayoutFailed();
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
