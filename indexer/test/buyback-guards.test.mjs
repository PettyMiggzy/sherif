import test from "node:test";
import assert from "node:assert/strict";
import { tooExpensive, buybackStats } from "../src/buybackkeeper.js";

// The deviation guard is the one that silently INVERTS if the pool's token sort is read wrong: get it
// backwards and the keeper refuses dips and buys only pumps — precisely the behaviour it exists to stop.
// Default MAX_TICK_DEV is 200.

test("token as token1 (WETH is token0): a LOWER tick means a more expensive token", () => {
  const isToken0 = false; // the pad token is token1
  // tick well BELOW the mean => token got expensive => refuse
  assert.equal(tooExpensive(-500, 0, isToken0), true);
  // tick ABOVE the mean => token got cheap => this is a dip, buy it
  assert.equal(tooExpensive(500, 0, isToken0), false);
});

test("token as token0: the orientation flips, and so must the guard", () => {
  const isToken0 = true;
  assert.equal(tooExpensive(500, 0, isToken0), true);   // higher tick => expensive => refuse
  assert.equal(tooExpensive(-500, 0, isToken0), false); // lower tick => cheap => buy
});

test("small moves inside the band are allowed — the guard blocks spikes, not noise", () => {
  assert.equal(tooExpensive(-199, 0, false), false); // inside 200
  assert.equal(tooExpensive(-201, 0, false), true);  // outside
});

test("with no mean yet the guard abstains rather than blocking every buy forever", () => {
  assert.equal(tooExpensive(12345, null, false), false);
});

test("the keeper is OFF unless explicitly configured", () => {
  const s = buybackStats();
  assert.equal(s.enabled, false);
  assert.equal(s.buys, 0);
});
