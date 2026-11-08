// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager as IRouterPoolManager} from "v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {RobinhoodStack} from "./RobinhoodStack.sol";
import {PadRouter} from "../src/PadRouter.sol";

/// @notice The pad on Kinetiq's Elysium (testnet chain 99801; mainnet's id
/// is passed at deploy time once Kinetiq publishes it). Same contracts as on
/// Robinhood Chain (RobinhoodStack), plus the two things Elysium doesn't
/// have from Uniswap yet:
///   - a v4 PoolManager: Uniswap's own v4-core code, compiled from this
///     repo's pinned copy, owned by `admin` (the owner can only ever turn on
///     Uniswap's protocol fee; nothing else). Pass an existing one to reuse it.
///   - PadRouter: the swap router the site uses, speaking UniversalRouter's
///     `execute` for v4 swaps, paid through the chain's canonical Permit2.
/// Pools are quoted in the chain's bridged USDC (6 decimals, like USDG, so
/// every dollar amount in the contracts means the same thing).
abstract contract ElysiumStack is RobinhoodStack {
    address internal stackPoolManager;
    address internal stackQuote;

    struct ElysiumDeploy {
        Stack stack;
        address poolManager;
        address router;
    }

    function _poolManager() internal view override returns (address) {
        return stackPoolManager;
    }

    function _quote() internal view override returns (address) {
        return stackQuote;
    }

    function _deployElysium(
        address owner,
        address create2Deployer,
        address admin,
        address quote,
        address existingPoolManager,
        address permit2,
        uint256 setupFee,
        string memory housePadName,
        address existingTreasury
    ) internal returns (ElysiumDeploy memory d) {
        require(quote.code.length > 0, "quote token has no code on this chain");
        require(IERC20Metadata(quote).decimals() == 6, "quote must have 6 decimals: the pad's dollar amounts assume it");
        require(permit2.code.length > 0, "Permit2 is missing on this chain");
        require(admin != address(0), "admin is zero");

        d.poolManager = existingPoolManager != address(0) ? existingPoolManager : address(new PoolManager(admin));
        require(d.poolManager.code.length > 0, "PoolManager has no code");
        stackPoolManager = d.poolManager;
        stackQuote = quote;

        d.router = address(new PadRouter(IRouterPoolManager(d.poolManager), IAllowanceTransfer(permit2)));
        d.stack = _deployStack(owner, create2Deployer, setupFee, housePadName, existingTreasury, admin);

        require(address(PadRouter(d.router).poolManager()) == d.poolManager, "router is on another PoolManager");
        require(address(PadRouter(d.router).permit2()) == permit2, "router has the wrong Permit2");
    }
}
