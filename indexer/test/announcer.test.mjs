// Tests for the launch announcer's message-building, focused on the promo-banner behavior.
//
// No network and no real Telegram bot: we stub global.fetch to capture every Telegram call the
// announcer makes, then assert the exact method + payload for each path. Env is set before each
// dynamic import (with a cache-busting query) so BANNER/CHAT are re-read per scenario.
//
//   node --test test/announcer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

const CHAT = "@robinlabslaunches";
const BANNER = "https://robinlab.io/assets/announce-banner.png";
const TOKEN_ADDR = "0x7ddec97ae156e99745e5d7870958118a6ff1db83";

// Install a fetch stub that records Telegram calls and returns whatever the scenario dictates.
// `fail` is a set of methods that should respond {ok:false} (to exercise the fallback ladder).
function stubFetch(calls, fail = new Set()) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const m = u.match(/\/bot[^/]+\/(\w+)/);
    if (m) {
      const method = m[1];
      const body = opts.body ? JSON.parse(opts.body) : {};
      calls.push({ method, body });
      const ok = !fail.has(method);
      return { ok: true, json: async () => (ok ? { ok: true, result: {} } : { ok: false, description: `stub-fail:${method}` }) };
    }
    throw new Error("unexpected non-telegram fetch in test: " + u);
  };
}

// Import a fresh copy of the module with the given env (cache-busted so module-level consts re-read env).
let importSeq = 0;
async function freshAnnouncer(env) {
  Object.assign(process.env, {
    TG_BOT_TOKEN: "TEST:token",
    TG_CHAT: CHAT,
    TG_API_BASE: "http://127.0.0.1:0", // never actually hit — fetch is stubbed
    ANNOUNCE_API_BASE: "http://api.example",
    ANNOUNCE_SITE_BASE: "https://robinlab.io",
    ANNOUNCE_BANNER_URL: "",
    ...env,
  });
  return import(`../src/announcer.js?case=${++importSeq}`);
}

const coinWithPfp = { token: TOKEN_ADDR, name: "Buy Me", symbol: "$BUYME", has_pfp: true, mcapUsd: 14500 };
const coinNoImg = { token: TOKEN_ADDR, name: "No Image", symbol: "NOIMG", has_pfp: false };

test("banner + coin image -> album with banner on top, coin image second, caption on banner", async () => {
  const calls = [];
  stubFetch(calls);
  const { announce } = await freshAnnouncer({ ANNOUNCE_BANNER_URL: BANNER });
  const ok = await announce(coinWithPfp);

  assert.equal(ok, true);
  assert.equal(calls.length, 1, "one Telegram call");
  const { method, body } = calls[0];
  assert.equal(method, "sendMediaGroup");
  assert.equal(body.chat_id, CHAT);
  assert.equal(body.media.length, 2);
  assert.equal(body.media[0].media, BANNER, "banner is first (on top)");
  assert.equal(body.media[0].parse_mode, "HTML");
  assert.match(body.media[0].caption, /Buy Me/, "caption carries the coin name");
  assert.match(body.media[0].caption, new RegExp(TOKEN_ADDR), "caption carries the contract address");
  assert.equal(body.media[1].media, `http://api.example/media/${TOKEN_ADDR}/pfp`, "coin image is second");
});

test("banner + no coin image -> single banner photo captioned", async () => {
  const calls = [];
  stubFetch(calls);
  const { announce } = await freshAnnouncer({ ANNOUNCE_BANNER_URL: BANNER });
  const ok = await announce(coinNoImg);

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendPhoto");
  assert.equal(calls[0].body.photo, BANNER);
  assert.match(calls[0].body.caption, /No Image/);
});

test("no banner + coin image -> coin image as the card (prior behavior)", async () => {
  const calls = [];
  stubFetch(calls);
  const { announce } = await freshAnnouncer({}); // BANNER blank
  const ok = await announce(coinWithPfp);

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendPhoto");
  assert.equal(calls[0].body.photo, `http://api.example/media/${TOKEN_ADDR}/pfp`);
});

test("no banner + no image -> text message", async () => {
  const calls = [];
  stubFetch(calls);
  const { announce } = await freshAnnouncer({});
  const ok = await announce(coinNoImg);

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.match(calls[0].body.text, /No Image/);
});

test("album fails -> falls back to banner photo -> then to text message", async () => {
  const calls = [];
  stubFetch(calls, new Set(["sendMediaGroup", "sendPhoto"])); // force both photo paths to fail
  const { announce } = await freshAnnouncer({ ANNOUNCE_BANNER_URL: BANNER });
  const ok = await announce(coinWithPfp);

  assert.equal(ok, true, "still succeeds via the text fallback");
  assert.deepEqual(calls.map((c) => c.method), ["sendMediaGroup", "sendPhoto", "sendMessage"]);
  assert.equal(calls[1].body.photo, BANNER, "photo fallback uses the banner");
  assert.match(calls[2].body.text, /Buy Me/);
});

test("caption is HTML-safe and brand-correct (no em-dash, CA in <code>)", async () => {
  const { caption } = await freshAnnouncer({});
  const text = caption({ token: TOKEN_ADDR, name: "A & B <script>", symbol: "$X", mcapUsd: 14500 });
  assert.match(text, /A &amp; B &lt;script&gt;/, "name is HTML-escaped");
  assert.match(text, new RegExp(`<code>${TOKEN_ADDR}</code>`), "CA wrapped in <code>");
  assert.ok(!text.includes("—"), "no em-dashes in brand copy");
  assert.match(text, /Market cap: \$14,500/);
});
