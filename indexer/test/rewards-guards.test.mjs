// Tests the two reward SCORING GUARDS added for the holder-rewards launch:
//   1) the holder min-balance threshold (sub-threshold wallets drop out → their slice → floor)
//   2) the exclusion set (curve/pool/bond/router/vault/vesting/dead never earn)
//
// Run: node --test test/rewards-guards.test.mjs   (from indexer/)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE importing anything that reads CFG. A 1000s epoch and a threshold of 5 bps of the
// 1e9 supply = 500,000 tokens time-averaged.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "rwg-")), "t.db");
process.env.EPOCH_LEN = "1000";
process.env.FINALITY_DELAY = "0";
process.env.REWARD_VAULT = "";
process.env.HOLDER_MIN_BPS = "5"; // 0.05% of 1e9 = 500,000 tokens (time-averaged) to accrue
const CURVE = "0x" + "11".repeat(20), POOL = "0x" + "22".repeat(20), BOND = "0x" + "33".repeat(20);
const VLOCK = "0x" + "44".repeat(20), ROUTER = "0x" + "55".repeat(20);
process.env.ROUTER = ROUTER;
process.env.TOKEN_VESTING_LOCK = VLOCK;

const { db, insertTrade, insertAccrual } = await import("../src/db.js");
const { computeEpoch, SIDE } = await import("../src/rewards.js");

const COIN = "0x" + "cc".repeat(20);
const WHALE = "0x" + "a1".repeat(20); // above threshold
const DUST = "0x" + "b2".repeat(20);  // below threshold
const T = (n) => BigInt(n) * 10n ** 18n;

let seq = 0;
const trade = (actor, side, tokens, ts) =>
  insertTrade.run({ tx: "0x" + (++seq).toString(16).padStart(64, "0"), log_index: 0, token: COIN,
    side, actor, eth: "0", tokens: String(tokens), fee: "0", block: seq, ts });
const accrue = (side, amount, ts) =>
  insertAccrual.run({ tx: "0x" + (++seq).toString(16).padStart(64, "0"), log_index: 0, coin: COIN,
    epoch: 5, side, amount: String(amount), block: seq, ts });

// Register the coin so excludedFor() can read its curve/pool/bond.
db.prepare("INSERT INTO coins (token, curve, pool, bond, dev, launch_ts, launch_block) VALUES (?,?,?,?,?,?,?)")
  .run(COIN, CURVE, POOL, BOND, "0x" + "de".repeat(20), 0, 0);

// Epoch 5 spans [5000, 6000). Everyone buys at t=5000 and holds the whole epoch.
trade(WHALE, "buy", T(600_000), 5000); // 600k > 500k threshold → earns
trade(DUST, "buy", T(100_000), 5000);  // 100k < 500k threshold → filtered → nothing
// Infra/sinks that must NEVER earn even though they "hold" big balances all epoch:
for (const infra of [CURVE, POOL, BOND, VLOCK, ROUTER]) trade(infra, "buy", T(50_000_000), 5000);
accrue(SIDE.Holders, 1_000_000n, 5500); // holder pot

test("holder min-balance threshold: whale accrues, dust is filtered", () => {
  const res = computeEpoch(5);
  const holders = res.entries.filter((l) => l.side === SIDE.Holders).map((l) => l.user.toLowerCase());
  assert.ok(holders.includes(WHALE.toLowerCase()), "whale (600k > 500k) should earn");
  assert.ok(!holders.includes(DUST.toLowerCase()), "dust (100k < 500k) should be filtered");
});

test("exclusion set: curve/pool/bond/router/vesting-lock never earn", () => {
  const res = computeEpoch(5);
  const earners = new Set(res.entries.map((l) => l.user.toLowerCase()));
  for (const infra of [CURVE, POOL, BOND, VLOCK, ROUTER]) {
    assert.ok(!earners.has(infra.toLowerCase()), `${infra} must be excluded from rewards`);
  }
});

test("conservation: Σ holder allocations ≤ the holder pot (floored, remainder → floor)", () => {
  const res = computeEpoch(5);
  const pot = 1_000_000n;
  const sum = res.entries.filter((l) => l.side === SIDE.Holders).reduce((s, l) => s + BigInt(l.amount), 0n);
  assert.ok(sum <= pot, `Σ alloc ${sum} must be ≤ pot ${pot}`);
});

test("floor routing: sub-threshold share is NOT redistributed to the whale", () => {
  // Whale 600k + dust 100k both hold the full epoch. The denominator is ALL holder
  // balance-seconds (700k), so the whale gets pot·600/700 and the dust's 100/700 slice
  // is left UNALLOCATED (→ swept to the coin's floor), not handed to the whale.
  const res = computeEpoch(5);
  const pot = 1_000_000n;
  const whaleAmt = res.entries
    .filter((l) => l.side === SIDE.Holders && l.user.toLowerCase() === WHALE.toLowerCase())
    .reduce((s, l) => s + BigInt(l.amount), 0n);
  const expected = (pot * 600_000n) / 700_000n; // whale's true pro-rata share of the FULL denominator
  assert.equal(whaleAmt, expected, `whale should get ${expected} (600/700 of pot), not the whole pot`);
  assert.ok(whaleAmt < pot, "whale must NOT absorb the sub-threshold dust's slice");
  const sum = res.entries.filter((l) => l.side === SIDE.Holders).reduce((s, l) => s + BigInt(l.amount), 0n);
  assert.ok(pot - sum >= (pot * 100_000n) / 700_000n - 1n, "the dust's ~100/700 slice must remain for the floor");
});
