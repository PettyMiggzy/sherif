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

module.exports = { approxStartTick, startTickForFdv, assertInBand };
