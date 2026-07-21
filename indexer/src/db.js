// SQLite schema + prepared statements. Everything the API serves is derived from
// two tables — coins (one row per launch, updated on graduation) and trades (one
// row per buy/sell). Aggregates like 24h volume are computed by query so they're
// always correct even after a reorg re-scan. Wei values are stored as TEXT.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CFG } from "./config.js";

mkdirSync(dirname(CFG.dbPath), { recursive: true });
export const db = new Database(CFG.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS coins (
  token        TEXT PRIMARY KEY,
  curve        TEXT,
  pool         TEXT,
  dev          TEXT,
  name         TEXT,
  symbol       TEXT,
  launch_block INTEGER,
  launch_ts    INTEGER,
  launch_tx    TEXT,
  dev_bought   TEXT DEFAULT '0',
  graduated    INTEGER DEFAULT 0,
  grad_block   INTEGER,
  grad_ts      INTEGER,
  raised_weth  TEXT,
  bond         TEXT,
  -- curve geometry (read once at launch) + a live snapshot (refreshed on trades)
  -- so the browse feed serves progress/mcap with ZERO per-coin RPC at scale.
  start_tick     INTEGER,
  min_grad_tick  INTEGER,
  grad_tick      INTEGER,
  grad_target    INTEGER,
  token0         TEXT,        -- for price orientation (WETH-per-token)
  last_tick      INTEGER,
  progress       REAL,        -- 0..1 along [start, ceiling]
  mcap_eth       REAL,
  snap_ts        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_coins_launch ON coins(launch_block DESC);
CREATE INDEX IF NOT EXISTS idx_coins_curve  ON coins(curve);

CREATE TABLE IF NOT EXISTS trades (
  tx        TEXT,
  log_index INTEGER,
  token     TEXT,
  side      TEXT,          -- 'buy' | 'sell'
  actor     TEXT,
  eth       TEXT,          -- wei, gross ETH in (buy) / out (sell)
  tokens    TEXT,          -- token units moved
  fee       TEXT,          -- fee wei
  block     INTEGER,
  ts        INTEGER,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token, block DESC);
CREATE INDEX IF NOT EXISTS idx_trades_ts    ON trades(ts DESC);

-- Raw RewardVault Accrued rows (one per trade's 0.25% leg). Stored raw + PK'd like trades so a reorg re-scan
-- purges & re-inserts them without double-counting; the (coin,epoch,side) pot is a SUM over these (in BigInt).
CREATE TABLE IF NOT EXISTS reward_accruals (
  tx        TEXT,
  log_index INTEGER,
  coin      TEXT,
  epoch     INTEGER,
  side      INTEGER,   -- 0 = Traders (buy leg), 1 = Holders (sell leg)
  amount    TEXT,      -- wei
  block     INTEGER,
  ts        INTEGER,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX IF NOT EXISTS idx_accruals_epoch ON reward_accruals(epoch);

-- One posted root per finalized epoch (write-once here; re-posts on veto update it in place).
CREATE TABLE IF NOT EXISTS reward_roots (
  epoch      INTEGER PRIMARY KEY,
  root       TEXT,
  algo_hash  TEXT,
  uri        TEXT,
  n_leaves   INTEGER,
  per_coin   TEXT,     -- JSON: per-coin pot vs allocated, for transparency
  posted_tx  TEXT,     -- postRoot() tx hash (null until posted on-chain)
  computed_ts INTEGER
);

-- The computed leaf set + proofs the claim API serves. Recomputed idempotently per epoch.
CREATE TABLE IF NOT EXISTS reward_claims (
  epoch  INTEGER,
  coin   TEXT,
  side   INTEGER,
  user   TEXT,
  amount TEXT,        -- wei
  proof  TEXT,        -- JSON array of bytes32
  PRIMARY KEY (epoch, coin, side, user)
);
CREATE INDEX IF NOT EXISTS idx_claims_user ON reward_claims(user);
`);

// Defensive migration: add any newer columns a pre-existing db is missing, so
// upgrading the indexer never needs a manual drop. (SQLite has no ADD COLUMN
// IF NOT EXISTS.)
const _cols = new Set(db.prepare("PRAGMA table_info(coins)").all().map((r) => r.name));
for (const [name, decl] of [
  ["start_tick", "INTEGER"], ["min_grad_tick", "INTEGER"], ["grad_tick", "INTEGER"],
  ["grad_target", "INTEGER"], ["token0", "TEXT"], ["last_tick", "INTEGER"],
  ["progress", "REAL"], ["mcap_eth", "REAL"], ["snap_ts", "INTEGER"],
]) {
  if (!_cols.has(name)) db.exec(`ALTER TABLE coins ADD COLUMN ${name} ${decl}`);
}

// ── cursor (last fully-processed block) ─────────────────────────────────────
const _getMeta = db.prepare("SELECT v FROM meta WHERE k = ?");
const _setMeta = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
export const getCursor = () => {
  const r = _getMeta.get("cursor");
  return r ? Number(r.v) : null;
};
export const setCursor = (n) => _setMeta.run("cursor", String(n));

// ── writes (idempotent — safe to re-run over the same blocks on a reorg) ─────
export const upsertCoin = db.prepare(`
INSERT INTO coins (token, curve, pool, dev, name, symbol, launch_block, launch_ts, launch_tx, dev_bought)
VALUES (@token, @curve, @pool, @dev, @name, @symbol, @launch_block, @launch_ts, @launch_tx, @dev_bought)
ON CONFLICT(token) DO UPDATE SET
  curve=excluded.curve, pool=excluded.pool, dev=excluded.dev,
  name=COALESCE(excluded.name, coins.name),
  symbol=COALESCE(excluded.symbol, coins.symbol),
  launch_block=excluded.launch_block, launch_ts=excluded.launch_ts,
  launch_tx=excluded.launch_tx, dev_bought=excluded.dev_bought
`);

export const markGraduated = db.prepare(`
UPDATE coins SET graduated=1, grad_block=@grad_block, grad_ts=@grad_ts,
  raised_weth=@raised_weth, bond=@bond WHERE curve=@curve
`);

export const insertTrade = db.prepare(`
INSERT INTO trades (tx, log_index, token, side, actor, eth, tokens, fee, block, ts)
VALUES (@tx, @log_index, @token, @side, @actor, @eth, @tokens, @fee, @block, @ts)
ON CONFLICT(tx, log_index) DO NOTHING
`);

// Curve geometry, written once when we first see the coin (after Launched).
export const setGeometry = db.prepare(`
UPDATE coins SET start_tick=@start_tick, min_grad_tick=@min_grad_tick,
  grad_tick=@grad_tick, grad_target=@grad_target, token0=@token0 WHERE token=@token
`);

// Dev changed the auto-graduate target (GradTargetSet), matched by curve.
export const setGradTargetByCurve = db.prepare("UPDATE coins SET grad_target=@grad_target WHERE curve=@curve");

// A live snapshot from the pool tick — refreshed whenever the coin trades.
export const setSnapshot = db.prepare(`
UPDATE coins SET last_tick=@last_tick, progress=@progress, mcap_eth=@mcap_eth, snap_ts=@snap_ts WHERE token=@token
`);

// Pools we still snapshot (not yet graduated) + geometry, keyed by token.
export const liveCoinsForSnapshot = db.prepare(`
SELECT token, pool, token0, start_tick, grad_tick FROM coins
WHERE graduated=0 AND pool IS NOT NULL AND start_tick IS NOT NULL AND token = ?
`);
export const coinGeom = db.prepare("SELECT token, pool, token0, start_tick, grad_tick FROM coins WHERE token = ?");

export const coinByCurve = db.prepare("SELECT token FROM coins WHERE curve = ?");
export const coinRow = db.prepare("SELECT token FROM coins WHERE token = ?");
export const setCoinNameSymbol = db.prepare("UPDATE coins SET name=?, symbol=? WHERE token=?");

// A reorg on the very tip can leave rows from an orphaned block. Before we
// re-scan a window we delete trades in it so the re-insert reflects the new
// canonical chain. (Coins are launch-once; we just re-upsert them.)
export const purgeTradesFrom = db.prepare("DELETE FROM trades WHERE block >= ?");

// ── rewards ──────────────────────────────────────────────────────────────────
export const insertAccrual = db.prepare(`
INSERT INTO reward_accruals (tx, log_index, coin, epoch, side, amount, block, ts)
VALUES (@tx, @log_index, @coin, @epoch, @side, @amount, @block, @ts)
ON CONFLICT(tx, log_index) DO NOTHING
`);
// Purged alongside trades in the reorg re-scan window (same block predicate).
export const purgeAccrualsFrom = db.prepare("DELETE FROM reward_accruals WHERE block >= ?");

export const upsertRewardRoot = db.prepare(`
INSERT INTO reward_roots (epoch, root, algo_hash, uri, n_leaves, per_coin, posted_tx, computed_ts)
VALUES (@epoch, @root, @algo_hash, @uri, @n_leaves, @per_coin, @posted_tx, @computed_ts)
ON CONFLICT(epoch) DO UPDATE SET
  root=excluded.root, algo_hash=excluded.algo_hash, uri=excluded.uri,
  n_leaves=excluded.n_leaves, per_coin=excluded.per_coin,
  posted_tx=COALESCE(excluded.posted_tx, reward_roots.posted_tx), computed_ts=excluded.computed_ts
`);
export const setRewardRootPostedTx = db.prepare("UPDATE reward_roots SET posted_tx=@posted_tx WHERE epoch=@epoch");
export const getRewardRoot = db.prepare("SELECT * FROM reward_roots WHERE epoch = ?");

export const deleteClaimsForEpoch = db.prepare("DELETE FROM reward_claims WHERE epoch = ?");
export const insertRewardClaim = db.prepare(`
INSERT INTO reward_claims (epoch, coin, side, user, amount, proof)
VALUES (@epoch, @coin, @side, @user, @amount, @proof)
ON CONFLICT(epoch, coin, side, user) DO UPDATE SET amount=excluded.amount, proof=excluded.proof
`);
export const getRewardClaim = db.prepare(
  "SELECT amount, proof FROM reward_claims WHERE epoch=? AND coin=? AND side=? AND user=?");
export const claimsForEpoch = db.prepare(
  "SELECT coin, side, user, amount, proof FROM reward_claims WHERE epoch = ?");
export const claimsForUser = db.prepare(
  "SELECT epoch, coin, side, amount, proof FROM reward_claims WHERE user = ? ORDER BY epoch DESC");
