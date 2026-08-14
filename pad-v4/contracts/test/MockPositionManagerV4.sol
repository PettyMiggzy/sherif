// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {MockPermit2} from "./MockPermit2.sol";

/// @title MockPositionManagerV4 — TEST-ONLY stand-in for the Uniswap V4 PositionManager mint path.
/// @notice The real PositionManager + Permit2 are pinned to solc 0.8.17 and can't compile under this repo's
/// 0.8.26/viaIR config, so the graduation mint can only be run on a fork. This mock lets the FULL graduate()
/// waterfall run against a REAL local PoolManager: it decodes the curve's exact (MINT_POSITION, SETTLE_PAIR,
/// SWEEP) batch, adds the liquidity, settles currency0 from the ETH the curve forwarded and currency1 by pulling
/// the seed token through the (mock) Permit2, mints a sequential tokenId to the requested owner (the LockVault),
/// and sweeps leftover ETH back. Selectors match IPositionManagerMinimal exactly.
contract MockPositionManagerV4 is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;
    MockPermit2 public immutable permit2;

    uint256 public nextTokenId = 1; // matches the real posm (ids start at 1)
    mapping(uint256 => address) public ownerOf;

    struct Ctx {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint256 liquidity;
        address payer; // the curve (pays the token via Permit2)
        address sweepTo; // leftover currency0 recipient
    }

    Ctx private _ctx;

    error DeadlinePassed();

    constructor(address poolManager_, address permit2_) {
        poolManager = IPoolManager(poolManager_);
        permit2 = MockPermit2(permit2_);
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        if (block.timestamp > deadline) revert DeadlinePassed();
        (, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[])); // actions byte-string unused (fixed batch)
        (PoolKey memory key, int24 tl, int24 tu, uint256 L,,, address owner,) =
            abi.decode(params[0], (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes));
        // The ETH curve sends (MINT_POSITION, SETTLE_PAIR, SWEEP) because currency0 is native and it forwards
        // more value than the mint owes. StockPadFactory sends only (MINT_POSITION, SETTLE_PAIR): both legs are
        // ERC20s pulled through Permit2, so there is nothing to sweep. Modelling only the 3-action shape meant
        // the stock launch path reverted on `params[2]` here and could never be exercised at all.
        address sweepTo = msg.sender;
        if (params.length > 2) (, sweepTo) = abi.decode(params[2], (Currency, address)); // (currency0, recipient)

        _ctx = Ctx({key: key, tickLower: tl, tickUpper: tu, liquidity: L, payer: msg.sender, sweepTo: sweepTo});
        poolManager.unlock("");

        uint256 id = nextTokenId++;
        ownerOf[id] = owner; // the position "NFT" → LockVault

        // sweep leftover currency0 (ETH rounding dust) back to the requested recipient
        uint256 leftover = address(this).balance;
        if (leftover > 0) {
            (bool ok,) = payable(sweepTo).call{value: leftover}("");
            require(ok, "sweep");
        }
    }

    function unlockCallback(bytes calldata) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pm");
        Ctx memory c = _ctx;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            c.key,
            ModifyLiquidityParams({
                tickLower: c.tickLower,
                tickUpper: c.tickUpper,
                liquidityDelta: int256(c.liquidity),
                salt: bytes32(0)
            }),
            ""
        );
        _resolve(c.key.currency0, delta.amount0(), c.payer, c.sweepTo);
        _resolve(c.key.currency1, delta.amount1(), c.payer, c.sweepTo);
        return "";
    }

    /// @dev Settle what the position owes (negative) or take what it is owed (positive). ETH (currency0) is
    /// settled from this contract's own balance; the token (currency1) is pulled from the payer via Permit2.
    function _resolve(Currency currency, int128 amt, address payer, address takeTo) internal {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            if (currency.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                permit2.transferFrom(payer, address(poolManager), uint160(owed), Currency.unwrap(currency));
                poolManager.settle();
            }
        } else if (amt > 0) {
            poolManager.take(currency, takeTo, uint256(uint128(amt)));
        }
    }

    receive() external payable {}
}
