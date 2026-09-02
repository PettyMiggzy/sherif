// Two routers are live at once: v1 keeps every coin launched before the v2 deploy, v2 serves everything
// since. A pad trade reaches the pool with the ROUTER as recipient, so the actor is only corrected back to
// the real wallet for a router the config knows about.
//
// The bug this pins: correctRouterActor() compared against ONE hardcoded router. A v2-launched coin's pad
// trades arrived with the v2 router as actor, matched nothing, and were credited to a contract address --
// silently wrong volume and leaderboards for every coin on the newer pad, with nothing logged.
import test from "node:test";
import assert from "node:assert/strict";

const V1 = "0x00000000000000000000000000000000000000a1";
const V2 = "0x00000000000000000000000000000000000000a2";
process.env.ROUTERS = `${V1},${V2}`;
const { correctRouterActor } = await import("../src/indexer.js");
const { CFG } = await import("../src/config.js");

const SELLER = "0x00000000000000000000000000000000000000b1";
const TOKEN = "0x00000000000000000000000000000000000000d3";
const TX = "0xdeadbeef";
const rowFor = (actor) => ({ tx: TX, token: TOKEN, side: "sell", actor });
const map = new Map([[`${TX}:${TOKEN}:sell`, SELLER]]);

test("the config carries BOTH routers", () => {
  assert.ok(CFG.routers.includes(V1), "v1 missing from CFG.routers");
  assert.ok(CFG.routers.includes(V2), "v2 missing from CFG.routers");
});

test("a v1-router trade is re-attributed to the real seller", () => {
  assert.equal(correctRouterActor(rowFor(V1), map).actor, SELLER);
});

test("a v2-router trade is re-attributed too — the bug was that this one was not", () => {
  assert.equal(correctRouterActor(rowFor(V2), map).actor, SELLER,
    "a v2-launched coin's pad trade must credit the wallet, not the router contract");
});

test("an unrelated address is left alone — this corrects routers, not everyone", () => {
  const stranger = "0x00000000000000000000000000000000000000ee";
  assert.equal(correctRouterActor(rowFor(stranger), map).actor, stranger);
});

test("a router trade with no matching event stays the router (buybacks must not score)", () => {
  assert.equal(correctRouterActor(rowFor(V2), new Map()).actor, V2);
});
