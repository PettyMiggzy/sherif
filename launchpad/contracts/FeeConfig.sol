// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title FeeConfig — the pad's single, owner-governed fee dial.
/// @notice Both CurvePool (the Uniswap 1% LP swap fee its single-sided position earns) and PadRouter (the
/// pad-UI swap fee) read their splits from HERE. So the platform owner can retune WHERE fees go and HOW MUCH —
/// for all future collections, across every coin, with a setter call and NO redeploy. Every dial has an
/// on-chain safety cap: the platform can never be starved, and the swap split always sums to 100%.
///
/// Recipients are roles, resolved at each call site: "platform" = the pad's platform wallet, "creator" = the
/// coin's own dev, "floor" = that coin's Bond floor. This contract only holds the *ratios*; it never holds or
/// moves funds, so it has no attack surface beyond the owner's ability to retune within the caps.
contract FeeConfig is Ownable2Step {
    // ── LP fee split (the curve position's Uniswap 1% tier) ──────────────────────────────
    // The creator's share of the LP fee, in bps; the platform takes the remainder. Capped at 50% so the
    // platform can never be starved of the fee it operates the pad on.
    uint16 public lpCreatorBps; // default 1000 = 10% to creator, 90% to platform
    uint16 public constant LP_CREATOR_MAX = 5000;

    // ── router swap fee split (pad-UI trades) — the three shares sum to 10000 ─────────────
    uint16 public swapPlatformBps; // default 4500 = 45%
    uint16 public swapCreatorBps; // default 4500 = 45%
    uint16 public swapFloorBps; //   default 1000 = 10% (deepens the coin's Bond floor)

    event LpSplitChanged(uint16 creatorBps);
    event SwapSplitChanged(uint16 platformBps, uint16 creatorBps, uint16 floorBps);

    constructor(address owner_) Ownable(owner_) {
        lpCreatorBps = 1000; // 10%
        swapPlatformBps = 4500; // 45%
        swapCreatorBps = 4500; // 45%
        swapFloorBps = 1000; // 10%
    }

    /// @notice Retune the creator's cut of the LP fee (0..50%; platform always keeps the rest).
    function setLpCreatorBps(uint16 bps) external onlyOwner {
        require(bps <= LP_CREATOR_MAX, "lp cap");
        lpCreatorBps = bps;
        emit LpSplitChanged(bps);
    }

    /// @notice Retune the router swap-fee split. The three shares must sum to exactly 100% (10000 bps).
    function setSwapSplit(uint16 platformBps, uint16 creatorBps, uint16 floorBps) external onlyOwner {
        require(uint256(platformBps) + creatorBps + floorBps == 10_000, "sum");
        swapPlatformBps = platformBps;
        swapCreatorBps = creatorBps;
        swapFloorBps = floorBps;
        emit SwapSplitChanged(platformBps, creatorBps, floorBps);
    }

    /// @notice The three swap-fee shares in one call (platform, creator, floor) — for the router.
    function swapSplit() external view returns (uint16 platformBps, uint16 creatorBps, uint16 floorBps) {
        return (swapPlatformBps, swapCreatorBps, swapFloorBps);
    }
}
