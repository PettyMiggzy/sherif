// Reward poster — turns finalized epochs into on-chain roots.
//
// Each pass: find every epoch that has (a) ended, (b) cleared the finalityDelay the contract enforces, and
// (c) not yet been posted; compute its allocation set + global Merkle root; persist the leaf set + proofs so the
// claim API can serve them; then, if a poster key is configured, call RewardVault.postRoot on-chain.
//
// Safe to run repeatedly and to crash/restart: computeEpoch is deterministic, persistence is idempotent
// (upserts keyed by epoch / leaf), and postRoot is skipped when the epoch already carries a root on-chain.
import { ethers } from "ethers";
import { db } from "./db.js";
import { CFG } from "./config.js";
import {
  upsertRewardRoot, setRewardRootPostedTx, getRewardRoot,
  deleteClaimsForEpoch, insertRewardClaim, getHeadTs,
} from "./db.js";
import { computeEpoch, currentEpoch, epochBounds, ALGO_HASH } from "./rewards.js";

const VAULT_ABI = [
  "function postRoot(uint256 epoch, bytes32 root, bytes32 algoHash, string uri) external",
  "function epochRoot(uint256) view returns (bytes32 root, bytes32 algoHash, uint64 postedAt, uint64 challengeWindow, uint64 claimWindow, bool vetoed)",
  "function currentEpoch() view returns (uint256)",
];

const _epochsWithAccruals = db.prepare("SELECT DISTINCT epoch FROM reward_accruals WHERE epoch < ? ORDER BY epoch ASC");

const uriFor = (epoch) => (CFG.rewardUriBase ? `${CFG.rewardUriBase}${epoch}` : `robinlabs:rewards:epoch:${epoch}`);

// Persist one computed epoch (root + per-coin summary + every leaf's proof) atomically.
function persist(computed) {
  const { epoch, root, algoHash, entries, perCoin } = computed;
  const tx = db.transaction(() => {
    deleteClaimsForEpoch.run(epoch);
    for (const e of entries) {
      insertRewardClaim.run({
        epoch, coin: e.coin, side: e.side, user: e.user.toLowerCase(),
        amount: e.amount, proof: JSON.stringify(e.proof),
      });
    }
    upsertRewardRoot.run({
      epoch, root, algo_hash: algoHash, uri: uriFor(epoch),
      n_leaves: entries.length, per_coin: JSON.stringify(perCoin),
      posted_tx: null, computed_ts: Math.floor(Date.now() / 1000),
    });
  });
  tx();
}

// Is epoch e finalized for posting? Mirror the contract's postRoot gate: the epoch has fully ended AND
// finalityDelay has elapsed past its end (so a root can't cover reorg-able blocks) AND — critically — the
// INDEXER has actually caught up past that boundary. Without the last check a lagging indexer would compute
// a root over an incomplete accrual set and post a permanently-wrong allocation on-chain.
function finalized(epoch, nowSec) {
  const { t1 } = epochBounds(epoch);
  const cutoff = t1 + CFG.finalityDelay;
  if (nowSec < cutoff) return false;
  // The indexed frontier MUST have passed the cutoff. head_ts === 0 means the indexer has not
  // yet recorded a frontier (fresh DB / mid-backfill) — treat that as "not caught up" and refuse
  // to post, rather than falling back to a time-only gate that would post over a partial accrual
  // set during backfill (a permanently-wrong on-chain allocation). The poster runs in-process
  // with the indexer, so head_ts becomes non-zero as soon as the first tick commits.
  if (getHeadTs() < cutoff) return false;
  return true;
}

// Compute + persist every finalized, unposted epoch. Returns the list processed. Does NOT touch the chain.
export function computePending() {
  const now = Math.floor(Date.now() / 1000);
  const cur = currentEpoch(now);
  const done = [];
  for (const { epoch } of _epochsWithAccruals.all(cur)) {
    if (!finalized(epoch, now)) continue;
    const existing = getRewardRoot.get(epoch);
    if (existing && existing.posted_tx) continue; // already on-chain; leave it
    const computed = computeEpoch(epoch);
    if (!computed.root) continue;                  // no eligible leaves (empty/holderless) — nothing to post
    persist(computed);
    done.push({ epoch, root: computed.root, leaves: computed.entries.length });
  }
  return done;
}

// Post any computed-but-unposted roots on-chain. Requires POSTER_KEY + REWARD_VAULT. Skips an epoch that already
// carries a root on-chain (writes the on-chain tx back so we don't retry). Returns the epochs posted.
export async function postPending() {
  if (!CFG.posterKey || !CFG.rewardVault) return [];
  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(CFG.posterKey, provider);
  const vault = new ethers.Contract(CFG.rewardVault, VAULT_ABI, wallet);
  const posted = [];
  const now = Math.floor(Date.now() / 1000);
  const cur = currentEpoch(now);
  for (const { epoch } of _epochsWithAccruals.all(cur)) {
    const row = getRewardRoot.get(epoch);
    if (!row || !row.root) continue; // nothing computed to post
    // Read the epoch's on-chain state up front so we can act on a VETO even for an epoch we
    // already recorded as posted — posted_tx is sticky (upsert COALESCEs it), so without this
    // a vetoed root would be skipped forever and its claims blocked.
    let onchain;
    try { onchain = await vault.epochRoot(epoch); }
    catch (e) { console.warn(`[poster] epochRoot ${epoch} read failed: ${e.shortMessage || e.message || e}`); continue; }
    if (row.posted_tx) {
      // Already posted. Re-post ONLY if the on-chain root was vetoed AND recomputing over the
      // current (possibly now-complete) accrual set yields a DIFFERENT root — i.e. the data was
      // corrected. Re-posting the identical vetoed root would just be vetoed again forever, so in
      // that case we leave posted_tx set and stop fighting the guardian until the data changes.
      // A live (non-vetoed) posted root is left untouched — no re-posting at all.
      if (onchain.vetoed) {
        const fresh = computeEpoch(epoch);
        if (fresh.root && fresh.root !== onchain.root) {
          persist(fresh);                                       // record the corrected allocation
          setRewardRootPostedTx.run({ epoch, posted_tx: null }); // un-gate: a later pass re-posts it
        }
      }
      continue;
    }
    if (onchain.root && onchain.root !== ethers.ZeroHash && !onchain.vetoed) {
      // computed but a (non-vetoed) root is already on-chain — record and move on, don't double-post
      setRewardRootPostedTx.run({ epoch, posted_tx: "onchain" });
      continue;
    }
    try {
      const tx = await vault.postRoot(epoch, row.root, row.algo_hash || ALGO_HASH, row.uri || uriFor(epoch));
      const rc = await tx.wait();
      setRewardRootPostedTx.run({ epoch, posted_tx: rc.hash });
      posted.push({ epoch, tx: rc.hash });
      console.log(`[poster] posted epoch ${epoch} root ${row.root.slice(0, 10)}… (${row.n_leaves} leaves) tx ${rc.hash}`);
    } catch (e) {
      console.warn(`[poster] postRoot epoch ${epoch} failed: ${e.shortMessage || e.message || e}`);
    }
  }
  return posted;
}

// One full pass: compute pending, then post pending.
export async function runPosterOnce() {
  const computed = computePending();
  if (computed.length) console.log(`[poster] computed ${computed.length} epoch(s): ${computed.map((c) => c.epoch).join(", ")}`);
  const posted = await postPending();
  return { computed, posted };
}

// Background loop — checks a few times per epoch (cheap; most passes are no-ops).
export async function runPosterLoop(intervalMs = 10 * 60 * 1000) {
  if (!CFG.rewardVault) { console.log("[poster] REWARD_VAULT unset — reward posting disabled"); return; }
  console.log(`[poster] vault=${CFG.rewardVault} epoch=${CFG.epochLen}s finalityDelay=${CFG.finalityDelay}s posting=${CFG.posterKey ? "on" : "off (compute-only)"}`);
  for (;;) {
    try { await runPosterOnce(); }
    catch (e) { console.error(`[poster] pass error: ${e.message || e}`); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
