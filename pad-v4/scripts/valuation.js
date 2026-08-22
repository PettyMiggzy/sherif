/*
 * valuation.js — turn a creator's choice ("1,000,000 tokens at ~2 ETH FDV") into a LaunchConfig start tick.
 *
 * Robin does NOT constrain supply. A creator can launch 10,000 tokens or 10,000,000,000 — supply alone carries
 * no information, and pinning it to 1B just forces every coin to quote in nano-ETH. What the factory bounds is
 * supply x launch price: the implied fully-diluted value (see contracts/core/PadValuation.sol).
 *
 * The pool is ETH(currency0)/token(currency1), so its price is TOKENS PER ETH:
 *     P = 1.0001^tick        FDV_wei = supplyRaw / P
 * A HIGHER start tick is a CHEAPER token (more of them per ETH), which is why the curve launches at a high tick
 * and graduates downward. `curveWidth` stays global, so moving the start tick moves the valuation without
 * changing the multiple every coin graduates at.
 *
 * The float pass below only gets close; the exact answer comes from the chain's own Q96 tick math via
 * `factory.quoteFdvWei`, so a client and the launch check can never disagree about whether a config is in band.
 */

/** Nearest tick-spacing-aligned start tick for `supplyRaw` (token base units) at `fdvWei` (wei). Float estimate. */
function approxStartTick(supplyRaw, fdvWei, tickSpacing) {
  const ratio = Number(supplyRaw) / Number(fdvWei); // = P, tokens per ETH
  if (!(ratio > 0) || !Number.isFinite(ratio)) throw new Error("valuation: supply/fdv out of representable range");
  const tick = Math.log(ratio) / Math.log(1.0001);
  return Math.round(tick / tickSpacing) * tickSpacing;
}

/**
 * Exact, chain-checked start tick.
 * Walks one tick-spacing at a time off the float estimate and returns the aligned tick whose ON-CHAIN FDV is
 * closest to the target. `factory` is a CurvePadFactoryV4 (needs `quoteFdvWei`).
 */
async function startTickForFdv(factory, supplyRaw, fdvWei, tickSpacing) {
  const target = BigInt(fdvWei);
  const base = approxStartTick(supplyRaw, target, tickSpacing);
  const abs = (x) => (x < 0n ? -x : x);
  let best = null;
  // +/-2 spacings is far more than the float error (which is well under one spacing); it costs 5 cheap views.
  for (let k = -2; k <= 2; k++) {
    const tick = base + k * tickSpacing;
    if (tick <= 0) continue; // the curve always launches at a positive tick magnitude; the factory rejects <= 0
    let got;
    try {
      got = await factory.quoteFdvWei(supplyRaw, tick);
    } catch {
      continue; // out of TickMath's usable range
    }
    const err = abs(got - target);
    if (best === null || err < best.err) best = { tick, fdvWei: got, err };
  }
  if (best === null) throw new Error("valuation: no usable start tick for that supply/FDV pair");
  return best;
}

/** Throws unless `fdvWei` sits inside the factory's currently-governed band. Call before spending gas. */
async function assertInBand(factory, fdvWei) {
  const [min, max] = await factory.fdvBand();
  if (BigInt(fdvWei) < min || BigInt(fdvWei) > max) {
    throw new Error(`valuation: FDV ${fdvWei} wei outside the governed band [${min}, ${max}] wei`);
  }
}

// ── the creator-facing layer: presets and dollars ──────────────────────────────────────────────────────────
//
// A creator does not think in ticks, and they barely think in wei. They think "1B supply, $4K market cap" —
// which is exactly how hood.dev frames the same two choices (supply presets 100M/420M/1B/69B, market-cap
// presets $2.5K/$4K/$10K/$25K, each with a freeform box beside it). The presets are a curated SUBSET of what
// the contract allows, not the limit: the band is what the contract enforces, and anything inside it launches.

/** Supply quick-picks, in WHOLE tokens. The box beside them takes any number; nothing here is a bound. */
const SUPPLY_PRESETS = [100_000_000n, 420_000_000n, 1_000_000_000n, 69_000_000_000n];

/** Opening market-cap quick-picks, in USD. Same deal — a starting point, not a constraint. */
const MARKET_CAP_PRESETS_USD = [2500, 4000, 10000, 25000];

/**
 * USD -> wei. Kept as its own function because it is THE weak link in the whole flow and should be visible:
 * `ethUsd` comes from off-chain and nothing on-chain can check it. This chain has no USD oracle, which is why
 * the contract's band is denominated in wei and the dollars live entirely in the client. A stale `ethUsd` does
 * not produce a wrong launch — it produces a launch at a different dollar valuation than the creator read on
 * screen, and if it is stale enough the band rejects it. Quote it fresh, and show the ETH figure too.
 */
function usdToWei(usd, ethUsd) {
  if (!(ethUsd > 0)) throw new Error("valuation: need a positive ETH/USD price");
  return BigInt(Math.round((Number(usd) / Number(ethUsd)) * 1e18));
}

/** wei -> USD, for presenting a band or a quote back to the creator. */
function weiToUsd(wei, ethUsd) {
  return (Number(wei) / 1e18) * Number(ethUsd);
}

/**
 * The whole creator flow in one call: "N whole tokens, opening at $X" -> the LaunchConfig fields.
 * Returns { supply, startTickMag, fdvWei, marketCapUsd } ready to drop into a launch, having checked the
 * governed band first so a doomed config never reaches a wallet prompt.
 */
async function launchFieldsFor(factory, wholeTokens, marketCapUsd, ethUsd, tickSpacing) {
  const supply = BigInt(wholeTokens) * 10n ** 18n;
  const targetWei = usdToWei(marketCapUsd, ethUsd);
  await assertInBand(factory, targetWei);
  const { tick, fdvWei } = await startTickForFdv(factory, supply, targetWei, tickSpacing);
  // report what the creator will ACTUALLY get, not what they asked for: the tick grid rounds, so the realised
  // market cap is within one tick-spacing of the target and the UI should show the realised number.
  return { supply, startTickMag: tick, fdvWei, marketCapUsd: weiToUsd(fdvWei, ethUsd) };
}

/** The governed band expressed in dollars, for the "you can launch between $A and $B" line in a UI. */
async function fdvBandUsd(factory, ethUsd) {
  const [min, max] = await factory.fdvBand();
  return { minUsd: weiToUsd(min, ethUsd), maxUsd: weiToUsd(max, ethUsd), minWei: min, maxWei: max };
}

module.exports = {
  approxStartTick, startTickForFdv, assertInBand,
  SUPPLY_PRESETS, MARKET_CAP_PRESETS_USD, usdToWei, weiToUsd, launchFieldsFor, fdvBandUsd,
};
