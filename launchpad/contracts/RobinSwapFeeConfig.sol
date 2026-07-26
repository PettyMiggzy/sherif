// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title RobinSwapFeeConfig — the owner-governed fee dial for RobinSwap.
/// @notice RobinSwap (the top-of-chain swap for external tokens) reads its per-side fee and the way that fee
/// splits into platform / Robin-LP / rewards from HERE, so the owner retunes the numbers with a setter and NO
/// redeploy. Holds only ratios, never funds. Every dial has an on-chain cap so a trade can never be over-taxed.
contract RobinSwapFeeConfig is Ownable2Step {
    uint16 public constant MAX_TOTAL_BPS = 400; // 4% hard cap per side (matches PadRouter's ceiling)

    // Total fee taken per side, in bps of notional. Default 125 = 1.25% each way (2.5% round trip).
    uint16 public buyTotalBps = 125;
    uint16 public sellTotalBps = 125;

    // How that fee splits: platform + LP shares (bps of the fee); the REMAINDER is the reward leg.
    // Default 4000 / 2000 → of a 1.25% side fee: 0.5% platform, 0.25% Robin LP, 0.5% rewards.
    uint16 public platformShareBps = 4000;
    uint16 public lpShareBps = 2000;

    event TotalsSet(uint16 buyBps, uint16 sellBps);
    event SplitSet(uint16 platformShareBps, uint16 lpShareBps);

    error TotalTooHigh();
    error SplitTooHigh();

    constructor(address owner_) Ownable(owner_) {}

    /// The rates RobinSwap reads each trade. `total` is the per-side fee bps; `platformShare`/`lpShare` are
    /// bps-of-the-fee, and the reward leg is `10000 - platformShare - lpShare`.
    function rates(bool isBuy) external view returns (uint256 total, uint16 platformShare, uint16 lpShare) {
        return (isBuy ? buyTotalBps : sellTotalBps, platformShareBps, lpShareBps);
    }

    function setTotals(uint16 buyBps, uint16 sellBps) external onlyOwner {
        if (buyBps > MAX_TOTAL_BPS || sellBps > MAX_TOTAL_BPS) revert TotalTooHigh();
        buyTotalBps = buyBps;
        sellTotalBps = sellBps;
        emit TotalsSet(buyBps, sellBps);
    }

    function setSplit(uint16 platformShareBps_, uint16 lpShareBps_) external onlyOwner {
        if (uint256(platformShareBps_) + lpShareBps_ > 10000) revert SplitTooHigh(); // reward leg = remainder
        platformShareBps = platformShareBps_;
        lpShareBps = lpShareBps_;
        emit SplitSet(platformShareBps_, lpShareBps_);
    }
}
