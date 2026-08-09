// Admin sign-in for the bot dashboard.
//
// The wallet being asked to sign is the platform wallet: it holds real money
// and it owns FeeConfig, so it can re-cut the fee split of every launch on the
// pad. That raises the bar above the profile/site signature flows this follows.
//
// Those flows sign the CONTENT being written, so replaying a captured
// signature just rewrites the same profile with the same values. A login signs
// nothing but "let me in" — so without a server-issued, single-use, expiring,
// origin-bound challenge, one captured signature is a permanent key to the
// control panel.
import { test } from "node:test";
import assert from "node:assert";
import { ethers } from "ethers";
import { createChallengeStore, adminMessage, adminsFromEnv, CHALLENGE_TTL_MS } from "../src/botsauth.js";

const PLATFORM = new ethers.Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = new ethers.Wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const ORIGIN = "https://robinlabs.fun";
const admins = [PLATFORM.address];

const clock = (start = 1_760_000_000_000) => {
  const c = { t: start };
  return { c, now: () => c.t };
};

const signFor = async (store, wallet, origin = ORIGIN) => {
  const ch = store.issue(origin);
  return { ...ch, signature: await wallet.signMessage(ch.message) };
};

test("the platform wallet gets in", async () => {
  const store = createChallengeStore();
  const { nonce, signature } = await signFor(store, PLATFORM);
  const r = store.verify({ nonce, signature, origin: ORIGIN, admins });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.address, PLATFORM.address.toLowerCase());
});

test("anyone else does not, however valid their signature", async () => {
  const store = createChallengeStore();
  const { nonce, signature } = await signFor(store, STRANGER);
  const r = store.verify({ nonce, signature, origin: ORIGIN, admins });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not an admin/);
});

test("an admin address in any letter case still matches", async () => {
  const store = createChallengeStore();
  const { nonce, signature } = await signFor(store, PLATFORM);
  const r = store.verify({
    nonce, signature, origin: ORIGIN,
    admins: [PLATFORM.address.toUpperCase().replace("0X", "0x")],
  });
  assert.strictEqual(r.ok, true,
    "EIP-55 checksums differ only in case; a case-sensitive compare locks out " +
    "the real admin depending on which wallet formatted the string");
});

// ---- replay ----------------------------------------------------------------

test("a signature cannot be used twice", async () => {
  const store = createChallengeStore();
  const { nonce, signature } = await signFor(store, PLATFORM);
  assert.strictEqual(store.verify({ nonce, signature, origin: ORIGIN, admins }).ok, true);

  const again = store.verify({ nonce, signature, origin: ORIGIN, admins });
  assert.strictEqual(again.ok, false,
    "a login signs nothing but 'let me in' — a replayable one is a permanent key");
});

test("a failed attempt burns the challenge too", async () => {
  const store = createChallengeStore();
  const ch = store.issue(ORIGIN);
  const wrong = await STRANGER.signMessage(ch.message);
  assert.strictEqual(store.verify({ nonce: ch.nonce, signature: wrong, origin: ORIGIN, admins }).ok, false);

  const right = await PLATFORM.signMessage(ch.message);
  assert.strictEqual(store.verify({ nonce: ch.nonce, signature: right, origin: ORIGIN, admins }).ok, false,
    "a nonce that survives a failure is one an attacker can keep trying against");
});

test("a challenge expires", async () => {
  const { c, now } = clock();
  const store = createChallengeStore({ now });
  const { nonce, signature } = await signFor(store, PLATFORM);
  c.t += CHALLENGE_TTL_MS + 1;
  assert.strictEqual(store.verify({ nonce, signature, origin: ORIGIN, admins }).ok, false);
});

test("expired challenges do not accumulate in memory", async () => {
  const { c, now } = clock();
  const store = createChallengeStore({ now });
  for (let i = 0; i < 50; i++) store.issue(ORIGIN);
  assert.strictEqual(store.size, 50);
  c.t += CHALLENGE_TTL_MS + 1;
  store.issue(ORIGIN);
  assert.strictEqual(store.size, 1, "an unbounded map of abandoned logins is a slow memory leak");
});

// ---- phishing --------------------------------------------------------------

test("a signature phished on another site does not work here", async () => {
  const evil = createChallengeStore();
  const ch = evil.issue("https://robinlabs.fun.attacker.example");
  const signature = await PLATFORM.signMessage(ch.message);

  const real = createChallengeStore();
  const mine = real.issue(ORIGIN);
  assert.strictEqual(real.verify({ nonce: mine.nonce, signature, origin: ORIGIN, admins }).ok, false,
    "the origin is inside the signed text, so a signature collected elsewhere " +
    "recovers to a different message and therefore a different address");
});

test("a challenge issued for one origin cannot be redeemed at another", async () => {
  const store = createChallengeStore();
  const { nonce, signature } = await signFor(store, PLATFORM, "https://staging.robinlabs.fun");
  const r = store.verify({ nonce, signature, origin: ORIGIN, admins });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /another site/);
});

// ---- the message a human sees ---------------------------------------------

test("the prompt names the site and says it moves nothing", () => {
  const msg = adminMessage({ origin: ORIGIN, nonce: "abc", issuedAt: 1_760_000_000_000 });
  assert.ok(msg.includes(ORIGIN), "an admin must be able to spot the wrong domain in the popup");
  assert.match(msg, /not a transaction/i,
    "this wallet owns FeeConfig — the prompt should make a transaction request " +
    "look obviously different from a sign-in");
  assert.ok(typeof msg === "string", "plain text, never a typed structure a wallet might render as a transaction");
});

// ---- configuration ---------------------------------------------------------

test("garbage input is refused rather than throwing", () => {
  const store = createChallengeStore();
  for (const bad of [{}, { nonce: "x" }, { nonce: null, signature: null }, { nonce: "x", signature: "0x" }]) {
    assert.doesNotThrow(() => store.verify({ ...bad, origin: ORIGIN, admins }));
    assert.strictEqual(store.verify({ ...bad, origin: ORIGIN, admins }).ok, false);
  }
});

test("no admins configured means nobody is admin, not everybody", async () => {
  const store = createChallengeStore();
  const { nonce, signature } = await signFor(store, PLATFORM);
  assert.strictEqual(store.verify({ nonce, signature, origin: ORIGIN, admins: [] }).ok, false);
  assert.strictEqual(store.verify({ nonce, signature, origin: ORIGIN, admins: undefined }).ok, false,
    "an admin surface that turns itself on because a variable is unset is the one that gets found");
});

test("adminsFromEnv reads a list and drops anything that is not an address", () => {
  const got = adminsFromEnv({
    BOTS_ADMINS: "0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf, not-an-address, 0x123, ",
  });
  assert.deepStrictEqual(got, ["0xcdd5ff5d521d3694c2a2f31edf7cd3c0e9a6fabf"]);
  assert.deepStrictEqual(adminsFromEnv({}), []);
});
