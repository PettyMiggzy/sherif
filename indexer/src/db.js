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

-- Coin profile: off-chain, creator-signed metadata (image, banner, socials). NOT from the
-- chain — set via POST /api/coin/:token/meta, which verifies the signer is the coin's dev.
-- Images are small blobs (size-capped) served by GET /media/:token/:kind. Purely cosmetic:
-- nothing here affects trading, and a missing row just means "no profile yet".
CREATE TABLE IF NOT EXISTS coin_meta (
  token       TEXT PRIMARY KEY,
  description TEXT,
  telegram    TEXT,
  twitter     TEXT,
  website     TEXT,
  pfp         BLOB,
  pfp_mime    TEXT,
  banner      BLOB,
  banner_mime TEXT,
  updated_ts  INTEGER,
  updated_by  TEXT       -- the dev address that signed the update
);

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
// Block timestamp of the indexed frontier (the confirmed safeHead). The reward
// poster reads this to confirm the indexer has caught up PAST an epoch boundary
// before it computes/posts that epoch's root — otherwise the accrual set could be
// incomplete and the on-chain root permanently wrong. 0 = never synced.
export const getHeadTs = () => { const r = _getMeta.get("head_ts"); return r ? Number(r.v) : 0; };
export const setHeadTs = (ts) => _setMeta.run("head_ts", String(ts));

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

// Undo graduation for any coin graduated at/after a block, used in the reorg re-scan:
// a Graduated log orphaned by a reorg (and not re-mined) would otherwise leave the coin
// stuck graduated=1 forever, since a re-emitted Graduated re-applies but a vanished one
// has no reset path. Clearing here lets the re-scan re-derive the true state.
export const ungraduateFrom = db.prepare(`
UPDATE coins SET graduated=0, grad_block=NULL, grad_ts=NULL, raised_weth=NULL, bond=NULL
WHERE grad_block >= ?
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
export const coinDev = db.prepare("SELECT token, dev FROM coins WHERE token = ?");

// ── coin profiles (creator-signed off-chain metadata) ──────────────────────────
// Text fields upsert every time; images are updated only when a new one is supplied
// (so re-saving text keeps the existing pfp/banner). Blobs are read on demand only.
export const upsertCoinMetaFields = db.prepare(`
  INSERT INTO coin_meta (token, description, telegram, twitter, website, updated_ts, updated_by)
  VALUES (@token, @description, @telegram, @twitter, @website, @updated_ts, @updated_by)
  ON CONFLICT(token) DO UPDATE SET
    description=excluded.description, telegram=excluded.telegram, twitter=excluded.twitter,
    website=excluded.website, updated_ts=excluded.updated_ts, updated_by=excluded.updated_by`);
export const setCoinPfp = db.prepare("UPDATE coin_meta SET pfp=@blob, pfp_mime=@mime WHERE token=@token");
export const setCoinBanner = db.prepare("UPDATE coin_meta SET banner=@blob, banner_mime=@mime WHERE token=@token");
// Lite = no blobs (for the feed join + the meta JSON); has_* flags say whether an image exists.
export const getCoinMetaLite = db.prepare(`
  SELECT token, description, telegram, twitter, website, updated_ts, updated_by,
         (pfp IS NOT NULL) AS has_pfp, (banner IS NOT NULL) AS has_banner
  FROM coin_meta WHERE token = ?`);
export const getCoinPfp = db.prepare("SELECT pfp AS blob, pfp_mime AS mime FROM coin_meta WHERE token = ?");
export const getCoinBanner = db.prepare("SELECT banner AS blob, banner_mime AS mime FROM coin_meta WHERE token = ?");

// A reorg on the very tip can leave rows from an orphaned block. Before we
// re-scan a window we delete trades in it so the re-insert reflects the new
// canonical chain. (Coins are launch-once; we just re-upsert them.)
export const purgeTradesFrom = db.prepare("DELETE FROM trades WHERE block >= ?");

// ── holdings / holders (derived from curve activity — no extra indexing) ───────
// Balance ≈ the creator's launch allocation (dev_bought, for the coin's dev) plus the
// net of every PadRouter buy/sell by that wallet. This is reorg-safe for free (it's a
// query over `trades` + `coins`). It reflects BONDING-CURVE activity: it does NOT see
// wallet-to-wallet ERC20 transfers or post-graduation DEX trades, so the client refines
// displayed numbers with a live balanceOf. Token amounts summed as REAL (whole-token
// precision is exact enough for a dashboard; exact wei live on /api/trades).
//
// One wallet's holdings: coins it launched or traded, with an approx balance (wei-scale).
export const holdingsByActor = db.prepare(`
  WITH tn AS (
    SELECT token,
           SUM(CASE WHEN side='buy' THEN CAST(tokens AS REAL) ELSE -CAST(tokens AS REAL) END) AS net_wei
    FROM trades WHERE actor=@a GROUP BY token
  )
  SELECT c.token, c.curve, c.pool, c.dev, c.name, c.symbol, c.graduated,
         c.mcap_eth, c.progress, c.launch_ts,
         cm.updated_ts AS meta_ts, (cm.pfp IS NOT NULL) AS has_pfp,
         (COALESCE(tn.net_wei,0) + CASE WHEN c.dev=@a THEN CAST(c.dev_bought AS REAL) ELSE 0 END) AS bal_wei
  FROM coins c
  LEFT JOIN tn ON tn.token = c.token
  LEFT JOIN coin_meta cm ON cm.token = c.token
  WHERE (tn.token IS NOT NULL OR c.dev=@a)
    AND (COALESCE(tn.net_wei,0) + CASE WHEN c.dev=@a THEN CAST(c.dev_bought AS REAL) ELSE 0 END) > 1e12
  ORDER BY bal_wei DESC
`);
// One coin's net position per wallet from trades (dev_bought is added to the dev in JS).
export const holdersByToken = db.prepare(`
  SELECT actor AS holder,
         SUM(CASE WHEN side='buy' THEN CAST(tokens AS REAL) ELSE -CAST(tokens AS REAL) END) AS net_wei
  FROM trades WHERE token=@t GROUP BY actor
`);

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
