/*
 * The supply ⇄ starting-value maths, alone in a file with no browser dependencies.
 *
 * It lives here rather than inside wallet.js for one reason: wallet.js imports ethers and touches window, so
 * it cannot be loaded by the contract test suite — and this is exactly the code that has to agree with the
 * contract. Kept separate, launchpad/test/fdv-site-math.test.js imports THIS file and checks the tick
 * magnitudes it produces against the factory's own quoteFdvWei and its own band, on a real launch. A copy of
 * these few lines inside a test would only ever prove the copy correct.
 *
 * The relationship, which is the factory's (see PoolMath.fdvWei):
 *     fdvWei = supplyWei / 1.0001^startTickMag
 * so a HIGHER magnitude is a CHEAPER token, and
 *     startTickMag = ln(supplyWei / fdvWei) / ln(1.0001)
 */
const LN_TICK = Math.log(1.0001);

/// Tick magnitude for `supplyWei` tokens opening at `fdvWei` total value, or 0 if there isn't a usable one.
///
/// Rounded DOWN to a multiple of 200, which the factory requires. Rounding the MAGNITUDE down makes the coin
/// slightly more expensive than asked rather than cheaper — which matters at the bottom of the band, where
/// rounding the other way would push a just-legal choice under the floor and revert the launch.
export function tickMagFor(supplyWei, fdvWei) {
  const supply = Number(supplyWei), fdv = Number(fdvWei);
  if (!(supply > 0) || !(fdv > 0)) return 0;
  const ratio = supply / fdv;
  // ratio <= 1 means one token is worth an ETH or more. The magnitude would be zero or negative and the
  // factory rejects both — this pad's geometry is built for cheap tokens, and a lot of them.
  if (!isFinite(ratio) || ratio <= 1) return 0;
  return Math.floor(Math.log(ratio) / LN_TICK / 200) * 200;
}

/// The factory's own bounds on a magnitude, mirrored so a client can explain a refusal instead of letting the
/// launch revert `BadValue`: positive, a multiple of 200, and leaving the curve ceiling inside Uniswap's
/// usable tick range.
export function magInRange(mag, curveWidth) {
  return mag > 0 && mag % 200 === 0 && mag + Number(curveWidth) <= 887200;
}
