// Two factories are live: v1 launched every coin up to the v2 deploy, v2 launches everything since.
//
// The bug this pins is the worst kind — a coin launched on the factory the indexer was not watching
// emitted its `Launched` event into the void. No row, no error, no log. The coin simply did not exist
// to the site: not in the feed, not on a page, not on the leaderboard. On-chain it was perfectly fine.
import test from "node:test";
import assert from "node:assert/strict";

const F1 = "0x00000000000000000000000000000000000000f1";
const F2 = "0x00000000000000000000000000000000000000f2";
const R1 = "0x00000000000000000000000000000000000000a1";
const R2 = "0x00000000000000000000000000000000000000a2";
process.env.FACTORIES = `${F1},${F2}`;
process.env.ROUTERS = `${R1},${R2}`;
const { CFG } = await import("../src/config.js");

test("both factories are in the config", () => {
  assert.ok(CFG.factories.includes(F1), "v1 factory missing");
  assert.ok(CFG.factories.includes(F2), "v2 factory missing — coins launched there would be invisible");
});

test("FACTORIES overrides rather than merging with the hardcoded defaults", () => {
  assert.equal(CFG.factories.length, 2, `expected exactly the two given, got ${CFG.factories.join(",")}`);
});

test("an explicitly set FACTORY is still honoured when FACTORIES is absent", async () => {
  // Re-import in a child so the module cache does not hand back the already-built CFG.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { CFG } from "./src/config.js"; console.log(JSON.stringify(CFG.factories));'],
    { env: { ...process.env, FACTORIES: "", FACTORY: F1 }, encoding: "utf8", cwd: process.cwd() });
  const list = JSON.parse(out.trim());
  assert.ok(list.includes(F1), `a named FACTORY must not be dropped for hardcoded defaults, got ${list}`);
});

test("reward exclusions cover EVERY factory and router, not just the first", async () => {
  const { CFG: c } = await import("../src/config.js");
  const excluded = new Set([...(c.factories || []), ...(c.routers || [])]);
  for (const a of [F1, F2, R1, R2]) {
    assert.ok(excluded.has(a), `${a} must be excluded from reward scoring — a contract must never earn`);
  }
});
