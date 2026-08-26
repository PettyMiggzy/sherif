const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// [BRAND] The `1ab5` miner is authored once (launchpad/mine/robin-mine.mjs) and COPIED to the two consumers
// that cannot import across directories: the Telegram bot (its Docker build context is its own folder) and the
// site (served statically to a browser). Copies drift. A drifted copy does not fail loudly on its own — it
// mines addresses the factory will never deploy to, and the only symptom is every launch from that client
// reverting BadTokenSuffix, far away from the cause. So the drift is caught here instead.
//
// If this fails: run `node scripts/sync-miner.mjs` from the repo root. Never hand-edit a copy.
describe("[BRAND] the vendored miner copies match the source", () => {
  const root = path.join(__dirname, "..", "..");
  const BANNER = "// GENERATED COPY — do not edit. Source: launchpad/mine/robin-mine.mjs (node scripts/sync-miner.mjs).\n";
  const source = fs.readFileSync(path.join(root, "launchpad/mine/robin-mine.mjs"), "utf8");

  for (const rel of ["launchbot/mine/robin-mine.mjs", "pad/assets/robin-mine.mjs"]) {
    it(`${rel} is byte-identical to the source`, () => {
      const p = path.join(root, rel);
      expect(fs.existsSync(p), `${rel} is missing — run: node scripts/sync-miner.mjs`).to.equal(true);
      expect(fs.readFileSync(p, "utf8"), `${rel} has drifted — run: node scripts/sync-miner.mjs`).to.equal(BANNER + source);
    });
  }
});
