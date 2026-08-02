// Per-coin website feature: slug moderation + the creator-signed wire contract.
// Pure/unit level — no server bind. Run: node --test test/site.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Isolate any DB the imported server graph opens (the byte-match test imports api.js).
process.env.DB_PATH ||= join(tmpdir(), `robinlabs-site-test-${process.pid}.db`);
import { ethers } from "ethers";
import { checkSlug, isValidStyle, isTakenDown, normalizeSlug, SITE_STYLES } from "../src/sitegate.js";

test("checkSlug: accepts good labels", () => {
  for (const s of ["pepe", "broke", "milo", "a1", "my-coin", "x2y", "web3frog"]) {
    assert.equal(checkSlug(s).ok, true, `${s} should pass`);
  }
});

test("checkSlug: normalizes case + trims", () => {
  const r = checkSlug("  PePe  ");
  assert.equal(r.ok, true);
  assert.equal(r.slug, "pepe");
});

test("checkSlug: format rules", () => {
  assert.equal(checkSlug("a").ok, false, "1 char too short");
  assert.equal(checkSlug("a".repeat(33)).ok, false, "over 32");
  assert.equal(checkSlug("-pepe").ok, false, "leading hyphen");
  assert.equal(checkSlug("pepe-").ok, false, "trailing hyphen");
  assert.equal(checkSlug("pe--pe").ok, false, "double hyphen");
  assert.equal(checkSlug("pe pe").ok, false, "space");
  assert.equal(checkSlug("pe.pe").ok, false, "dot");
  assert.equal(checkSlug("pe_pe").ok, false, "underscore");
  assert.equal(checkSlug("café").ok, false, "non-ascii");
  assert.equal(checkSlug("xn--abc").ok, false, "punycode prefix");
});

test("checkSlug: reserved + phishing words blocked", () => {
  for (const s of ["www", "api", "admin", "robin", "robinlabs", "labs", "docs", "pad",
                   "robinhood", "uniswap", "metamask", "airdrop", "verify", "support"]) {
    assert.equal(checkSlug(s).ok, false, `${s} must be reserved`);
  }
});

test("checkSlug: wordlist blocks abuse substrings", () => {
  // rot13("nigger") = "avttre" is in the built-in list; a slug containing it is refused.
  assert.equal(checkSlug("xxniggerxx").ok, false);
  // a clean slug that merely contains an allowed word passes
  assert.equal(checkSlug("bigger").ok, true);
});

test("takedown blocklist refuses a slug (env-driven, evaluated at import — documented)", () => {
  // isTakenDown reflects SITE_SLUG_BLOCKLIST; with none set nothing is taken down.
  assert.equal(isTakenDown("anything"), false);
  assert.equal(normalizeSlug("  ABC "), "abc");
});

test("style allow-list", () => {
  assert.equal(SITE_STYLES.length, 10);
  assert.equal(isValidStyle("neonvault"), true);
  assert.equal(isValidStyle("brutalist"), true);
  assert.equal(isValidStyle("nope"), false);
  assert.equal(isValidStyle(""), false);
});

test("site signature: creator can sign, server recovers the same address", async () => {
  // Mirror the exact wire format both sides use (indexer siteMessage / pad website.html).
  const siteMessage = (token, style, slug, ts) => {
    const canon = JSON.stringify({ style: style || "", slug: slug || "", ts });
    return `Robin Labs - set coin website\ntoken: ${String(token).toLowerCase()}\nts: ${ts}\ndigest: ${ethers.id(canon)}`;
  };
  const w = ethers.Wallet.createRandom();
  const token = "0x6360b2f602a71241b65e10665e962165f5e942bd";
  const ts = 1_700_000_000;
  const msg = siteMessage(token, "brutalist", "broke", ts);
  const sig = await w.signMessage(msg);
  assert.equal(ethers.verifyMessage(msg, sig).toLowerCase(), w.address.toLowerCase());
  // a tampered slug breaks recovery (anti-replay to a different slug)
  const tampered = siteMessage(token, "brutalist", "otherslug", ts);
  assert.notEqual(ethers.verifyMessage(tampered, sig).toLowerCase(), w.address.toLowerCase());
});

test("site signature matches the server's exported siteMessage byte-for-byte", async () => {
  const { siteMessage } = await import("../src/api.js");
  const local = (token, style, slug, ts) =>
    `Robin Labs - set coin website\ntoken: ${String(token).toLowerCase()}\nts: ${ts}\ndigest: ${ethers.id(JSON.stringify({ style, slug, ts }))}`;
  const token = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca";
  assert.equal(siteMessage(token, { style: "aurora", slug: "milo", ts: 42 }),
               local(token, "aurora", "milo", 42));
});
