// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BondGeometry — the shipped Bounty wall band, in one place
/// @notice The Bounty is the Bond's permanent WETH buy wall. Where it sits is the single most security-relevant
/// number in the pad, so it is named here rather than typed into each deploy script by hand.
///
/// [H-5] WHY IT IS DEEP. The original wall started one tick-spacing off spot (NEAR = 200, ~2% below). That is
/// farmable: an attacker pushes the price down, holds it, lets the wall fill at his price, and takes the spread.
/// No duration- or TWAP-based gate fixes it — holding a price costs nothing per unit of time, and on-chain a
/// held price and a real crash are the same observation. The wall is therefore bounded in CAPITAL: put it far
/// enough below spot that manipulating into it is worth less than holding the price there costs. Measured on the
/// live v3 Bond, attacker profit crosses to negative around 6000 ticks below spot and saturates by ~12000.
///
/// THE TRADE THIS MAKES, STATED PLAINLY: at NEAR = 9000 the wall no longer "buys every dip". It is a CRASH
/// CATCHER that engages roughly 59% below spot. Any product copy promising dip-buying is now false.
library BondGeometry {
    /// ~59% below spot — inside the measured safe margin (crossover ~6000, saturation ~12000).
    int24 internal constant BOUNTY_NEAR = 9000;
    /// ~79% below spot. Keeps the original 6600-tick wall WIDTH, just moved down.
    int24 internal constant BOUNTY_FAR = 15600;

    /// The ORIGINAL, drainable band. Kept only so tests can reproduce the attack against what is live today.
    int24 internal constant LEGACY_BOUNTY_NEAR = 200;
    int24 internal constant LEGACY_BOUNTY_FAR = 6800;
}
