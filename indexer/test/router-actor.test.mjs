// Regression test for the CRITICAL reward-scoring bug: a pad SELL routes tokens into the
// router, so the pool Swap's `recipient` is the router (an excluded address) and the sell
// was dropped from reward scoring. correctRouterActor() re-attributes it to the real seller
// via the router's Sold event side-channel. Guards against that bug ever returning.
//
// Run: node --test test/router-actor.test.mjs   (from indexer/)
import test from "node:test";
import assert from "node:assert/strict";

process.env.ROUTER = "0x00000000000000000000000000000000000000aa"; // known router for the test
const { correctRouterActor } = await import("../src/indexer.js");

const ROUTER = "0x00000000000000000000000000000000000000aa";
const SELLER = "0x00000000000000000000000000000000000000b1";
const BUYER  = "0x00000000000000000000000000000000000000c2";
const TOKEN  = "0x00000000000000000000000000000000000000d3";
const TX     = "0xdeadbeef";

test("router-mediated SELL is re-attributed to the real seller", () => {
  const map = new Map([[`${TX}:${TOKEN}:sell`, SELLER]]);
  const row = { tx: TX, token: TOKEN, side: "sell", actor: ROUTER, eth: "1", tokens: "2" };
  const out = correctRouterActor(row, map);
  assert.equal(out.actor, SELLER, "sell must score for the seller, not the router");
});

test("token casing in the row does not break the lookup", () => {
  const map = new Map([[`${TX}:${TOKEN}:sell`, SELLER]]);
  const row = { tx: TX, token: TOKEN.toUpperCase(), side: "sell", actor: ROUTER };
  assert.equal(correctRouterActor(row, map).actor, SELLER);
});

test("router recipient with NO matching event stays the router (excluded, e.g. buyback)", () => {
  const row = { tx: TX, token: TOKEN, side: "buy", actor: ROUTER };
  assert.equal(correctRouterActor(row, new Map()).actor, ROUTER, "unmatched router swap must not be misattributed");
});

test("a normal buy (recipient = buyer) is left untouched", () => {
  const map = new Map([[`${TX}:${TOKEN}:buy`, BUYER]]);
  const row = { tx: TX, token: TOKEN, side: "buy", actor: BUYER };
  assert.equal(correctRouterActor(row, map).actor, BUYER);
});

test("null row is passed through safely", () => {
  assert.equal(correctRouterActor(null, new Map()), null);
});
