// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuoteAdapter} from "../interfaces/IQuoteAdapter.sol";
import {IStockGuardAdapter} from "../interfaces/IRobinInterfaces.sol";

/// @notice The subset of a Robinhood Stock Token (a beacon proxy, 18-dec) the adapter reads. [H-3] Every call
/// is made by low-level staticcall with a return-length check, so neither a revert NOR a short return on these
/// optional getters can brick the adapter. (try/catch alone was not enough: it does not catch a decode failure.)
interface IStockToken {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function oraclePaused() external view returns (bool);
    function paused() external view returns (bool);
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
    function decimals() external view returns (uint8);
}

interface IStockRegistry {
    function paused() external view returns (bool);
    function isBlocked(address account) external view returns (bool);
}

/// @title StockQuoteAdapter — the RobinBlue (tokenized-stock pad) seam
/// @notice Makes a Robinhood Stock Token usable as a pad's QUOTE asset. Four jobs:
///   1. Deploy-time ALLOW-LIST gate: the ctor requires the stock's `ACCESS_CONTROLLED_REGISTRY()` to
///      equal the known platform registry — the single place securities/legal gating attaches. A token
///      that isn't a registry-governed stock cannot be wired as a quote.
///   2. Corporate-action CURB signal: `scheduledEffectiveAt()` (the IStockGuardAdapter surface the hook's
///      beforeSwap reads) returns the stock's `effectiveAt` when a `newUIMultiplier` (split/dividend) is
///      pending, so the hook halts trading inside the guard window. Try/caught → a broken read never curbs.
///   3. UI display: `displayScalar()` = `uiMultiplier()` (the pad quotes raw pool units; the UI divides by
///      this for per-share display). `marketDataStale()` = `oraclePaused()` — a banner only, never a gate.
///   4. `tradeable(parties[])` — a best-effort, NEVER-reverting status the router/UI can curb on: false if
///      the stock or registry is paused, or any party is blocklisted. It is advisory only; a paused/blocked
///      stock still hard-freezes the pad inside the PoolManager (inherent, disclosed — see below).
///
/// INHERENT, DISCLOSED stock risks (cannot be fixed on-chain):
///   • [D1] A stock `paused()` or a blocklisted PoolManager/hook HARD-FREEZES that pad — every swap moves
///     the stock through settle/take inside PoolManager core, outside any try/catch. `tradeable()` only
///     helps the router/UI; a direct swap still reverts. Per-pad isolation holds (ETH/other pads unaffected).
///   • [D3] `adminBurn` bypasses pause+blocklist and can burn the pool's stock reserve, letting an
///     arbitrageur drain the other side. Not preventable on-chain — mitigated by the deploy-time allow-list
///     (only issuers who contractually won't adminBurn pool addresses) + disclosure. Counterparty risk.
contract StockQuoteAdapter is IQuoteAdapter, IStockGuardAdapter {
    uint256 internal constant WAD = 1e18;

    address public immutable stock; // the quote asset (a Robinhood Stock Token)
    address public immutable registry; // its ACCESS_CONTROLLED_REGISTRY (matched at deploy)

    error ZeroAddress();
    error NotAStock();
    error RegistryMismatch();

    /// @param stock_ the stock token to use as the pad quote
    /// @param expectedRegistry the platform's known STOCK_REGISTRY — the allow-list authority
    constructor(address stock_, address expectedRegistry) {
        if (stock_ == address(0) || expectedRegistry == address(0)) revert ZeroAddress();
        // Must be a registry-governed stock: this call reverts (or returns 0) for a non-stock → gated out.
        address reg = IStockToken(stock_).ACCESS_CONTROLLED_REGISTRY();
        if (reg == address(0)) revert NotAStock();
        if (reg != expectedRegistry) revert RegistryMismatch();
        stock = stock_;
        registry = reg;
    }

    // ------------------------------------------------------------ IQuoteAdapter --

    function quote() external view returns (address) {
        return stock;
    }

    function quoteDecimals() external pure returns (uint8) {
        return 18; // Robinhood Stock Tokens are 18-dec
    }

    /// @notice No native yield — a stock's value is the V4 pool price, not an accruing balance.
    function harvest(address) external pure returns (uint256) {
        return 0;
    }

    // -------------------------------------------------------- IStockGuardAdapter --

    /// @notice The hook's §3.4 curb reads this. Return the scheduled corporate-action time (a pending
    /// `newUIMultiplier` taking effect at `effectiveAt`), or 0 if none / unreadable. Never reverts.
    function scheduledEffectiveAt() external view returns (uint256) {
        uint256 nm = _readWord(stock, abi.encodeCall(IStockToken.newUIMultiplier, ()), 0);
        if (nm == 0) return 0;
        return _readWord(stock, abi.encodeCall(IStockToken.effectiveAt, ()), 0);
    }

    // ------------------------------------------------------- display / status ----

    /// @notice The per-share display scalar (raw pool units ÷ this = shares). Defaults to 1e18 if unreadable.
    function displayScalar() external view returns (uint256) {
        uint256 m = _readWord(stock, abi.encodeCall(IStockToken.uiMultiplier, ()), WAD);
        return m == 0 ? WAD : m;
    }

    /// @notice "Market data stale/closed" banner signal only — does NOT gate trading.
    function marketDataStale() external view returns (bool) {
        return _readFlag(stock, abi.encodeCall(IStockToken.oraclePaused, ()), false);
    }

    /// @notice Best-effort, NEVER-reverting tradeability over the stock + registry + a set of parties.
    /// Advisory for the router/UI — a false result should curb the UI; it does NOT and cannot stop a direct
    /// on-chain swap (see the D1 disclosure).
    function tradeable(address[] calldata parties) external view returns (bool) {
        // unreadable stock pause state → treat as PAUSED (the old catch returned false outright; same answer)
        if (_readFlag(stock, abi.encodeCall(IStockToken.paused, ()), true)) return false;
        // unreadable registry state → ignore, exactly as the old empty catches did
        if (_readFlag(registry, abi.encodeCall(IStockRegistry.paused, ()), false)) return false;
        for (uint256 i; i < parties.length; ++i) {
            if (parties[i] == address(0)) continue;
            if (_readFlag(registry, abi.encodeCall(IStockRegistry.isBlocked, (parties[i])), false)) return false;
        }
        return true;
    }

    // ------------------------------------------------------------ safe reads ----

    /// @dev [H-3] Every read above is documented as best-effort and NEVER-reverting, and `try/catch` does not
    /// deliver that. try/catch catches reverts; it does NOT catch a failure to decode the return data, because
    /// the decode runs in THIS frame after the call has already succeeded. A `stock` or `registry` returning
    /// fewer than 32 bytes — which any contract answering every selector with `PUSH1 0 PUSH1 0 RETURN` does —
    /// therefore reverted straight through the catch. Both targets are chosen by whoever launched the pad, so
    /// the NatSpec promise has to hold against a hostile one. A low-level staticcall with a length check does.
    function _readWord(address target, bytes memory cd, uint256 fallbackValue) private view returns (uint256) {
        (bool ok, bytes memory data) = target.staticcall(cd);
        if (!ok || data.length < 32) return fallbackValue;
        return abi.decode(data, (uint256));
    }

    /// @dev As _readWord, but decodes the word by hand rather than as a `bool`: abi.decode(_, (bool)) reverts on
    /// any word that is not exactly 0 or 1, which would re-open the same hole for a dirty return value.
    function _readFlag(address target, bytes memory cd, bool fallbackValue) private view returns (bool) {
        (bool ok, bytes memory data) = target.staticcall(cd);
        if (!ok || data.length < 32) return fallbackValue;
        return abi.decode(data, (uint256)) != 0;
    }
}
