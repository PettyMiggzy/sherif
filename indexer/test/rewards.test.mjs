// End-to-end reward-scoring test: seed trades + Accrued rows, compute an epoch, and assert the whole contract:
// leaf parity with the on-chain formula, conservation (Σ alloc ≤ pot), the two scoring rules (trader
// net-accumulation, holder balance-seconds), and that every proof verifies against the posted root.
//
// Run: node --test test/rewards.test.mjs   (from indexer/)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module at a throwaway db + a small epoch BEFORE importing anything that reads CFG.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "rw-")), "t.db");
process.env.EPOCH_LEN = "1000";
process.env.FINALITY_DELAY = "0";
process.env.REWARD_VAULT = ""; // compute-only; no chain

const { db, insertTrade, insertAccrual } = await import("../src/db.js");
const { computeEpoch, leafHash, SIDE } = await import("../src/rewards.js");
const { StandardMerkleTree } = await import("@openzeppelin/merkle-tree");
const { ethers } = await import("ethers");

const COIN = "0x" + "cc".repeat(20);
const A = "0x" + "a1".repeat(20); // Alice
const B = "0x" + "b2".repeat(20); // Bob
const C = "0x" + "c3".repeat(20); // Carol
const LEAF_TYPES = ["uint256", "address", "uint8", "address", "uint256"];

let seq = 0;
const trade = (actor, side, tokens, ts) =>
  insertTrade.run({ tx: "0x" + (++seq).toString(16).padStart(64, "0"), log_index: 0, token: COIN,
    side, actor, eth: "0", tokens: String(tokens), fee: "0", block: seq, ts });
const accrue = (side, amount, ts) =>
  insertAccrual.run({ tx: "0x" + (++seq).toString(16).padStart(64, "0"), log_index: 0, coin: COIN,
    epoch: 5, side, amount: String(amount), block: seq, ts });

// Epoch 5 spans [5000, 6000).
// Carol bought 2000 BEFORE the epoch and holds throughout (carry-in).
trade(C, "buy", 2000n * 10n ** 18n, 4000);
// Intra-epoch:
trade(A, "buy", 1000n * 10n ** 18n, 5100);
trade(B, "buy", 3000n * 10n ** 18n, 5200);
trade(A, "sell", 500n * 10n ** 18n, 5500);
// Pots (wei): trader pot 4 ETH, holder pot 5 ETH.
accrue(SIDE.Traders, 4n * 10n ** 18n, 5300);
accrue(SIDE.Holders, 5n * 10n ** 18n, 5600);

const res = computeEpoch(5);

test("root is produced and every leaf hash matches the on-chain formula", () => {
  assert.ok(res.root, "expected a root");
  const tree = StandardMerkleTree.of(
    res.leaves.map((l) => [BigInt(l[0]), l[1], l[2], l[3], BigInt(l[4])]), LEAF_TYPES);
  assert.equal(tree.root, res.root, "rebuilt root must match");
  for (const l of res.leaves) {
    const oz = tree.leafHash([BigInt(l[0]), l[1], l[2], l[3], BigInt(l[4])]);
    const contract = leafHash(BigInt(l[0]), l[1], l[2], l[3], BigInt(l[4]));
    assert.equal(oz, contract, "OZ leaf hash must equal the contract's keccak(keccak(abi.encode(...)))");
  }
});

test("every entry's proof verifies against the root", () => {
  for (const e of res.entries) {
    const value = [5n, e.coin, e.side, e.user, BigInt(e.amount)];
    assert.ok(StandardMerkleTree.verify(res.root, LEAF_TYPES, value, e.proof), `proof for ${e.user}/${e.side}`);
  }
});

test("conservation: Σ allocations ≤ pot on both sides", () => {
  const pc = res.perCoin[COIN];
  assert.ok(BigInt(pc.traderAlloc) <= BigInt(pc.traderPot), "trader alloc ≤ pot");
  assert.ok(BigInt(pc.holderAlloc) <= BigInt(pc.holderPot), "holder alloc ≤ pot");
  assert.equal(pc.traderPot, (4n * 10n ** 18n).toString());
  assert.equal(pc.holderPot, (5n * 10n ** 18n).toString());
});

const amt = (side, user) => {
  const e = res.entries.find((x) => x.side === side && x.user.toLowerCase() === user.toLowerCase());
  return e ? BigInt(e.amount) : 0n;
};

test("trader side rewards net accumulation (Bob 3000 > Alice 500; Carol 0)", () => {
  // net in-epoch: Alice 1000-500=500, Bob 3000, Carol 0.
  const a = amt(SIDE.Traders, A), b = amt(SIDE.Traders, B), c = amt(SIDE.Traders, C);
  assert.equal(c, 0n, "Carol did not trade in-epoch → no trader reward");
  assert.ok(b > a && a > 0n, "Bob > Alice > 0");
  // Ratio ~ 3000:500 = 6:1 (within rounding).
  assert.ok(b >= a * 5n && b <= a * 7n, `Bob/Alice ratio ~6, got ${b}/${a}`);
});

test("holder side rewards balance-seconds (Bob 2.4M > Carol 2.0M > Alice 0.65M)", () => {
  // bs: Alice 1000*400 + 500*500 = 650k; Bob 3000*800 = 2.4M; Carol 2000*1000 = 2.0M.
  const a = amt(SIDE.Holders, A), b = amt(SIDE.Holders, B), c = amt(SIDE.Holders, C);
  assert.ok(b > c && c > a && a > 0n, `expected Bob>Carol>Alice>0, got ${b} ${c} ${a}`);
  const totalBs = 650000n + 2400000n + 2000000n;
  const pot = 5n * 10n ** 18n;
  // Each within 1 wei of floor(pot * bs / totalBs).
  const exp = (bs) => (pot * bs) / totalBs;
  for (const [user, bs] of [[A, 650000n], [B, 2400000n], [C, 2000000n]]) {
    const got = amt(SIDE.Holders, user);
    const e = exp(bs);
    assert.ok(got === e, `holder alloc for ${user}: got ${got} expected ${e}`);
  }
});

test("algoHash is the keccak of the frozen spec", () => {
  assert.equal(res.algoHash, ethers.keccak256(ethers.toUtf8Bytes(
    "RobinLabs-Rewards-v1|traders=max(0,net_token_accumulation_in_epoch)|" +
    "holders=balance_seconds_from_trades(carry_in,clamp0)|alloc=floor(pot*w/sumW)|" +
    "leaf=keccak(keccak(abi.encode(uint256 epoch,address coin,uint8 side,address user,uint256 amount)))")));
});
