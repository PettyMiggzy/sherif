// ─────────────────────────────────────────────────────────────────────────────
// Credit gate for the art generator — the bridge between an on-chain balance and an off-chain
// image model.
//
// THE ORDER OF OPERATIONS IS THE WHOLE DESIGN, so it is written out:
//
//   1. PRECHECK by simulating the real spend (`staticCall` on spendWithSig). One eth_call proves
//      every precondition at once — the signature is valid, the nonce is unused, the deadline has
//      not passed, the balance covers it — and proves it against the SAME code that will later
//      enforce it, rather than against a re-implementation here that could drift from it. It also
//      handles smart-contract wallets for free: an ERC-1271 signature cannot be checked locally,
//      and reimplementing that check off-chain is exactly the kind of second source of truth that
//      goes wrong quietly.
//   2. RESERVE locally. The precheck reads committed state, so two requests arriving in the same
//      second with two different nonces both pass it while only one balance exists. The reservation
//      is what stops the second one, and it lives in this process because it only needs to survive
//      the ~15 seconds a generation takes.
//   3. GENERATE.
//   4. SPEND, only now, only on success. Charging first would mean a failed generation needs a
//      refund path, and ArtCredits deliberately has none. The cost of this order is that a
//      generation whose spend transaction later fails was free; the precheck plus the reservation
//      make that rare, and the per-minute rate limit bounds it even if it stops being rare.
//
// THE OPERATOR KEY HELD HERE CANNOT SPEND ANYTHING ON ITS OWN. It relays an authorisation the
// customer signed. Stealing it buys an attacker the ability to pay our gas for us.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import { CFG } from "./config.js";

const ABI = [
  // The custom errors are listed so ethers can DECODE a revert into a name. Without them every
  // failure arrives as "execution reverted" and the customer gets a shrug instead of "that approval
  // expired".
  "error NonceUsed(uint256 nonce)",
  "error SigExpired(uint256 deadline)",
  "error BadSignature()",
  "error NotEnoughCredits(uint256 has, uint256 need)",
  "error NotOperator()",
  "error Zero()",
  "function credits(address) view returns (uint256)",
  "function usedNonce(address,uint256) view returns (bool)",
  "function spendWithSig(address user, uint256 amount, uint256 nonce, uint256 deadline, bytes signature)",
  "function quote(uint256 n) view returns (uint256 ethCost, uint256 tokenCost)",
  "function weiPerCredit() view returns (uint256)",
];

let _wallet = null;
let _contract = null;
let _provider = null;

export function enabled() {
  return !!(CFG.artCredits && CFG.artOperatorKey);
}

// This module owns its chain access rather than borrowing the API layer's — the API layer has none,
// and a paywall that silently shares a connection with request serving is a coupling nobody wants to
// discover during an incident. Same free-first ordering the indexer uses: CFG.readOrder puts the free
// endpoints ahead of the paid one, and a stall bound is what makes that pay rather than just hurt.
function provider() {
  if (_provider) return _provider;
  const urls = CFG.readOrder && CFG.readOrder.length ? CFG.readOrder : [CFG.rpcUrl];
  if (urls.length <= 1) {
    _provider = new ethers.JsonRpcProvider(urls[0], undefined, { staticNetwork: true });
    return _provider;
  }
  const net = { chainId: CFG.chainId, name: "robinhood" };
  _provider = new ethers.FallbackProvider(
    urls.map((url, i) => ({
      provider: new ethers.JsonRpcProvider(url, net, { staticNetwork: true }),
      priority: i + 1, weight: 1, stallTimeout: 2000,
    })), net, { quorum: 1 },
  );
  return _provider;
}

function contract() {
  if (_contract) return _contract;
  _wallet = new ethers.Wallet(CFG.artOperatorKey, provider());
  _contract = new ethers.Contract(CFG.artCredits, ABI, _wallet);
  return _contract;
}

export function operatorAddress() {
  if (!CFG.artOperatorKey) return null;
  try { return new ethers.Wallet(CFG.artOperatorKey).address; } catch { return null; }
}

// ── in-flight reservations ───────────────────────────────────────────────────
// user => { n, at }. Cleared on completion; also swept by age so a crash mid-generation cannot
// strand someone's credits forever behind a reservation that never resolves.
const _held = new Map();
const HOLD_MS = 5 * 60 * 1000;

function heldFor(user) {
  const h = _held.get(user);
  if (!h) return 0;
  if (Date.now() - h.at > HOLD_MS) { _held.delete(user); return 0; }
  return h.n;
}
function hold(user, n) {
  const cur = heldFor(user);
  _held.set(user, { n: cur + n, at: Date.now() });
}
function unhold(user, n) {
  const cur = heldFor(user);
  if (cur <= n) _held.delete(user);
  else _held.set(user, { n: cur - n, at: Date.now() });
}

/// What `user` can actually spend right now — their on-chain balance minus anything already
/// reserved by a generation still running in this process.
export async function available(user) {
  const c = new ethers.Contract(CFG.artCredits, ABI, provider());
  const bal = Number(await c.credits(user));
  return Math.max(0, bal - heldFor(String(user).toLowerCase()));
}

/**
 * Step 1 + 2: prove the spend would succeed, then reserve it.
 *
 * Returns a `release(ok)` you MUST call: `release(true)` after the spend transaction lands,
 * `release(false)` if the generation failed and nothing should be charged.
 */
export async function reserve({ user, amount, nonce, deadline, signature }) {
  const key = String(user).toLowerCase();

  // The reservation check comes first and uses the same numbers the precheck will: on-chain
  // balance minus in-flight holds.
  const free = await available(user);
  if (free < amount) {
    const err = new Error(free === 0
      ? "you have no credits left — top up to keep generating"
      : `you have ${free} credit${free === 1 ? "" : "s"} available, this needs ${amount}`);
    err.code = "NO_CREDITS";
    throw err;
  }

  // Simulate the real call. Anything wrong with the authorisation surfaces here, before we spend
  // money generating an image we could not charge for.
  try {
    await contract().spendWithSig.staticCall(user, amount, nonce, deadline, signature);
  } catch (e) {
    const err = new Error(decodeSpendError(e));
    err.code = "BAD_AUTH";
    throw err;
  }

  hold(key, amount);
  let settled = false;
  return async function release(ok) {
    if (settled) return null;
    settled = true;
    try {
      if (!ok) return null;
      return await serialize(async () => {
        const c = contract();
        const p = provider();
        const from = operatorAddress();
        let gasPrice = (await p.getFeeData()).gasPrice;
        if (gasPrice == null) gasPrice = BigInt(await p.send("eth_gasPrice", []));
        const n = await nextNonce(p, from);
        try {
          // Legacy type-0: this is an Orbit L2 with no EIP-1559.
          const tx = await c.spendWithSig(user, amount, nonce, deadline, signature,
            { type: 0, gasPrice, nonce: n });
          _nonce = n + 1;
          const rc = await tx.wait();
          return rc?.hash || tx.hash;
        } catch (err) {
          _nonce = null; // re-read from the chain next time rather than guess whether n was consumed
          throw err;
        }
      });
    } catch (e) {
      // The image has already been handed over, so this is revenue lost, not a user-facing error.
      // Logged loudly because a run of these means the operator is out of gas or has been
      // de-authorised, and the generator is silently free until somebody notices.
      console.error(`[credits] SPEND FAILED for ${user} (${amount} credits) — image already delivered:`,
        e?.shortMessage || e?.message || e);
      return null;
    } finally {
      unhold(key, amount);
    }
  };
}

/// Turn a revert into something a person can act on. Reads the decoded custom error name when ethers
/// could resolve one (the ABI above lists them for exactly this), and falls back to string matching.
function decodeSpendError(e) {
  const name = e?.revert?.name || "";
  const s = name || String(e?.shortMessage || e?.message || e || "");
  if (s.includes("NonceUsed")) return "that request was already used — refresh and try again";
  if (s.includes("SigExpired")) return "that approval expired — try again";
  if (s.includes("BadSignature")) return "could not verify your signature — reconnect your wallet and retry";
  if (s.includes("NotEnoughCredits")) return "not enough credits — top up to keep generating";
  if (s.includes("NotOperator")) return "the generator is not authorised to charge credits yet";
  return "could not verify your credits — try again";
}

// ── one spend at a time, with a nonce we track ourselves ─────────────────────
//
// TWO SEPARATE THINGS BREAK WITHOUT THIS, and the first one is not obvious.
//
// Asking the node for the operator's transaction count right after a transaction was mined can
// return the OLD count — measured against a local node: the count read 1 both before and after a
// spend landed, so the next spend was built on nonce 1 as well and died with "nonce has already been
// used". In production that is every back-to-back generation silently failing to charge, which nobody
// notices because the customer got their image.
//
// The second is plain concurrency: several people finish generating at once, and every spend goes out
// from the SAME operator key. Unserialised, they race for the same nonce and all but one lose.
//
// So sends are queued one at a time and the nonce is kept here, seeded from the chain and re-synced
// whenever a send fails — a failed send may or may not have consumed the nonce, and guessing is worse
// than asking.
let _queue = Promise.resolve();
let _nonce = null;

function serialize(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.then(() => {}, () => {}); // the chain must survive a rejection
  return run;
}

async function nextNonce(p, from) {
  if (_nonce === null) _nonce = await p.getTransactionCount(from, "pending");
  return _nonce;
}

export function stats() {
  const holds = [..._held.values()].reduce((a, h) => a + h.n, 0);
  return { enabled: enabled(), operator: operatorAddress(), inFlightCredits: holds };
}
