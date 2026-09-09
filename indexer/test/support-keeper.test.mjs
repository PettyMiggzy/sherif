import test from "node:test";
import assert from "node:assert/strict";
import { supportStats } from "../src/supportkeeper.js";
import { runSupportKeeper } from "../src/supportkeeper.js";

// The support keeper exists because "anyone can call it" is not a plan: on the live v3 stack graduate()
// has been permissionless and bounty-paying since launch and never once fired — 9 coins, 0 graduated.
// These pin the two properties that keep it from being harmful while it is not configured.

test("OFF unless explicitly configured — it must be inert in every deployment that has not opted in", () => {
  const s = supportStats();
  assert.equal(s.enabled, false);
  assert.equal(s.pads, 0);
  assert.equal(s.sent, 0);
});

test("the disabled path RETURNS rather than hanging — keeper.js imports it statically", async () => {
  // A disabled module that looped or threw here would take the whole keeper process with it.
  await runSupportKeeper();
  assert.equal(supportStats().passes, 0); // and it did no work on the way out
});
