// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev [H-3/M-17] Succeeds for every selector and returns ZERO bytes. This is the shape `try/catch` cannot
/// absorb: the call does not revert, so the catch never fires; the caller's ABI decoder then reverts in the
/// CALLER's own frame when it finds fewer than 32 bytes to decode. Not an exotic construction — an EOA behaves
/// this way for every selector, as does a proxy whose implementation slot is momentarily zero.
/// TEST-ONLY: never deployed to mainnet.
contract ShortReturner {
    fallback() external {}
}

interface IWord {
    function word() external view returns (uint256);
}

/// @dev The defect itself, isolated: exactly the `try/catch` shape the fixed contracts used to rely on. Calling
/// this against a ShortReturner REVERTS despite the catch, which is what makes the regression tests non-vacuous
/// — it proves the mock really is the shape try/catch cannot absorb, rather than merely a reverting target.
/// TEST-ONLY.
contract TryCatchDecoder {
    function readViaTryCatch(address target) external view returns (uint256) {
        try IWord(target).word() returns (uint256 v) {
            return v;
        } catch {
            return 0;
        }
    }
}

/// @dev A "stock" that satisfies StockQuoteAdapter's constructor gate — it answers ACCESS_CONTROLLED_REGISTRY
/// honestly — and then short-returns every optional getter the adapter reads. This is H-2's premise: passing
/// the gate takes only a contract with code and a working registry pointer. TEST-ONLY.
contract ShortReturningStock {
    address public immutable reg;

    constructor(address r) {
        reg = r;
    }

    function ACCESS_CONTROLLED_REGISTRY() external view returns (address) {
        return reg;
    }

    fallback() external {}
}

/// @dev Returns a full 32-byte word that is neither 0 nor 1. Harmless when decoded as a uint256, but
/// `abi.decode(data, (bool))` reverts on it — so decoding a flag as a bool would re-open the same hole that
/// a length check alone closes. TEST-ONLY.
contract DirtyBoolReturner {
    fallback() external {
        assembly {
            mstore(0, not(0))
            return(0, 32)
        }
    }
}
