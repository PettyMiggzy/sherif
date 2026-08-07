// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IQuoteAdapter} from "../interfaces/IQuoteAdapter.sol";
import {IStockGuardAdapter} from "../interfaces/IRobinInterfaces.sol";

/// @notice The subset of a Robinhood Stock Token (a beacon proxy, 18-dec) the adapter reads. Every
/// call is made through try/catch, so exact ABI drift on optional getters can never brick the adapter.
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
        try IStockToken(stock).newUIMultiplier() returns (uint256 nm) {
            if (nm == 0) return 0;
            try IStockToken(stock).effectiveAt() returns (uint256 ea) {
                return ea;
            } catch {
                return 0;
            }
        } catch {
            return 0;
        }
    }

    // ------------------------------------------------------- display / status ----

    /// @notice The per-share display scalar (raw pool units ÷ this = shares). Defaults to 1e18 if unreadable.
    function displayScalar() external view returns (uint256) {
        try IStockToken(stock).uiMultiplier() returns (uint256 m) {
            return m == 0 ? WAD : m;
        } catch {
            return WAD;
        }
    }

    /// @notice "Market data stale/closed" banner signal only — does NOT gate trading.
    function marketDataStale() external view returns (bool) {
        try IStockToken(stock).oraclePaused() returns (bool p) {
            return p;
        } catch {
            return false;
        }
    }

    /// @notice Best-effort, NEVER-reverting tradeability over the stock + registry + a set of parties.
    /// Advisory for the router/UI — a false result should curb the UI; it does NOT and cannot stop a direct
    /// on-chain swap (see the D1 disclosure).
    function tradeable(address[] calldata parties) external view returns (bool) {
        try IStockToken(stock).paused() returns (bool p) {
            if (p) return false;
        } catch {
            return false; // unreadable pause state → treat as not tradeable
        }
        try IStockRegistry(registry).paused() returns (bool p) {
            if (p) return false;
        } catch {}
        for (uint256 i; i < parties.length; ++i) {
            if (parties[i] == address(0)) continue;
            try IStockRegistry(registry).isBlocked(parties[i]) returns (bool b) {
                if (b) return false;
            } catch {}
        }
        return true;
    }
}
