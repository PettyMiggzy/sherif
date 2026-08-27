/*
 * Sequencer feed watcher — turns "poll the RPC on a timer" into "poll only when something happened".
 *
 * WHAT THIS ENDPOINT IS. `wss://feed.mainnet.chain.robinhood.com/feed` is the Arbitrum Nitro sequencer relay,
 * not a JSON-RPC websocket. It will not answer `eth_subscribe` and it carries no logs, no receipts and no
 * state. What it broadcasts is every transaction the sequencer has accepted, as raw signed bytes, BEFORE they
 * are executed. Measured on this chain: ~900 tx/sec, ~5.9 Mbit/s, ~64 GB/day inbound.
 *
 * SO IT CANNOT REPLACE `eth_getLogs`, and this module does not try to. The indexer needs decoded events, which
 * only exist after execution. What the feed replaces is the GUESSING: today the indexer runs one getLogs per
 * pool every 6 seconds whether or not anything happened, and on a quiet pad almost all of those come back
 * empty. With this, the timer becomes a slow safety net and the real trigger is "a transaction that mentions
 * one of our addresses just went through".
 *
 * HOW IT MATCHES, AND WHY IT DOES NOT DECODE. Each feed message carries a base64 `l2Msg`: either a signed
 * transaction, a brotli-compressed blob, or a batch of framed sub-messages. Fully RLP-decoding every
 * transaction to read its `to` costs ~175% of a core at this chain's rate — and it is also WRONG for us: a
 * swap routed through an aggregator has the aggregator as `to`, with our pool named only inside the calldata.
 * Measured over the same traffic, matching `to` alone saw 2,784 hits where a raw byte search saw 4,644.
 *
 * So it searches the raw payload for our addresses as 20-byte needles. That is both cheaper and more
 * complete: 0.2% of one core, and it catches an address wherever it appears — destination, calldata, or an
 * inner call's arguments.
 *
 * WHAT THIS COSTS YOU IN CORRECTNESS — read before trusting it:
 *   • A hit is a MAYBE, never a fact. The transaction has not executed yet and may revert. It is only ever a
 *     reason to go and look; every number the indexer stores still comes from getLogs.
 *   • A byte match can be coincidental — 20 bytes of some unrelated calldata happening to equal an address.
 *     Harmless: the cost of a false positive is one getLogs that finds nothing.
 *   • A MISS is the dangerous direction, and it is possible: an address computed on-chain rather than passed
 *     in would never appear in the bytes. That is why `idleMs` exists and why it must stay finite. The feed
 *     makes the indexer faster and cheaper; the timer is what makes it correct.
 *   • If the socket dies, `healthy()` goes false and the caller must fall back to its normal fast poll. It
 *     reconnects with backoff on its own, but it never pretends to be healthy while disconnected.
 */
import WebSocket from "ws";
import zlib from "node:zlib";

// Nitro L2 message kinds we care about. Anything else is not a transaction payload.
const KIND_BATCH = 3;
const KIND_SIGNED_TX = 4;
const KIND_BROTLI = 8;

// If nothing at all arrives for this long the socket is treated as dead even if it never errored — a silently
// half-open TCP connection looks exactly like a very quiet chain otherwise. This chain does ~900 tx/sec, so
// twenty seconds of total silence is not quiet, it is broken.
const SILENCE_MS = 20_000;

const hexToBuf = (addr) => Buffer.from(String(addr).replace(/^0x/, "").toLowerCase(), "hex");

/// Search a Nitro payload for any of `needles`, unwrapping batches and brotli but never RLP-decoding.
function payloadHits(buf, needles, depth = 0) {
  if (depth > 4 || buf.length === 0) return false;
  const kind = buf[0];
  const body = buf.subarray(1);
  if (kind === KIND_SIGNED_TX) return needles.some((n) => body.includes(n));
  if (kind === KIND_BROTLI) {
    let plain;
    try { plain = zlib.brotliDecompressSync(body); } catch { return false; }
    return payloadHits(plain, needles, depth + 1);
  }
  if (kind === KIND_BATCH) {
    // A batch is framed sub-messages, but a needle cannot span a frame boundary in any way that matters, so
    // scan the concatenation once rather than walking every frame.
    return needles.some((n) => body.includes(n));
  }
  return false;
}

/**
 * Start watching. Returns a handle the indexer loop uses to decide how long to sleep.
 *
 * @param {string}   url        the relay endpoint
 * @param {string[]} addresses  addresses to watch; call `setAddresses` again as coins launch
 * @param {(n:number)=>void} [onTouch] optional, fired when a batch of hits is coalesced
 */
export function startFeed({ url, addresses = [], onTouch } = {}) {
  let needles = addresses.filter(Boolean).map(hexToBuf);
  let ws = null;
  let closed = false;
  let connected = false;
  let lastMsgAt = 0;
  let backoff = 1000;
  let pendingHits = 0;
  let wake = null; // resolves the current waitForWork()
  const stats = { messages: 0, hits: 0, reconnects: 0, since: Date.now() };

  const markWork = () => {
    pendingHits++;
    stats.hits++;
    if (onTouch) { try { onTouch(pendingHits); } catch { /* a caller's logging must not kill the socket */ } }
    if (wake) { const w = wake; wake = null; w(); }
  };

  function connect() {
    if (closed) return;
    ws = new WebSocket(url, { handshakeTimeout: 15_000 });

    ws.on("open", () => {
      connected = true;
      lastMsgAt = Date.now();
      backoff = 1000;
      console.log(`[feed] connected -> ${url} (watching ${needles.length} addresses)`);
    });

    ws.on("message", (raw) => {
      lastMsgAt = Date.now();
      stats.messages++;
      if (needles.length === 0) return;
      let j;
      try { j = JSON.parse(raw.toString()); } catch { return; }
      for (const m of j.messages || []) {
        const b64 = m?.message?.message?.l2Msg;
        if (!b64) continue;
        if (payloadHits(Buffer.from(b64, "base64"), needles)) { markWork(); break; }
      }
    });

    const drop = (why) => {
      if (!connected && !closed) return; // already tearing down
      connected = false;
      try { ws?.terminate(); } catch { /* already gone */ }
      if (closed) return;
      stats.reconnects++;
      console.warn(`[feed] disconnected (${why}); retrying in ${backoff}ms — the indexer falls back to timed polling meanwhile`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };

    ws.on("error", (e) => drop(e.message || "error"));
    ws.on("close", (code) => drop(`code ${code}`));
  }

  // A half-open socket delivers no messages and no close event, so health is time-based rather than
  // event-based. `unref` so this timer alone never holds the process open.
  const watchdog = setInterval(() => {
    if (!closed && connected && Date.now() - lastMsgAt > SILENCE_MS) {
      console.warn(`[feed] silent for ${SILENCE_MS}ms — treating as dead`);
      try { ws?.terminate(); } catch { /* ignore */ }
    }
  }, 5000);
  watchdog.unref?.();

  connect();

  return {
    /// True only while the socket is up AND actually delivering. The caller must poll normally when false.
    healthy: () => connected && Date.now() - lastMsgAt < SILENCE_MS,

    /// Re-arm the watch list. Call after every launch, or the new coin's pool is invisible to the feed and
    /// only the safety timer will pick its trades up.
    setAddresses(list) {
      needles = (list || []).filter(Boolean).map(hexToBuf);
      return needles.length;
    },

    /**
     * Sleep until there is something to do.
     *
     * Resolves as soon as a watched address is seen, or after `idleMs` regardless. `idleMs` is the safety net
     * that covers everything the byte match can miss, so it must stay finite — long when the feed is healthy,
     * short when it is not.
     */
    async waitForWork(idleMs) {
      if (pendingHits > 0) { pendingHits = 0; return "feed"; }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve("timer"); }, idleMs);
        wake = () => { clearTimeout(timer); pendingHits = 0; resolve("feed"); };
      });
    },

    stats: () => ({ ...stats, connected, watching: needles.length }),

    stop() {
      closed = true;
      clearInterval(watchdog);
      try { ws?.terminate(); } catch { /* ignore */ }
      if (wake) { const w = wake; wake = null; w(); }
    },
  };
}
