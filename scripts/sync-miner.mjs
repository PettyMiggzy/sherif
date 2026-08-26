#!/usr/bin/env node
/*
 * Copy the ONE authored `1ab5` miner out to the consumers that cannot import it across directories.
 *
 * The source of truth is launchpad/mine/robin-mine.mjs — that is where it is edited and where the contract
 * suite pins it against the chain. Two consumers cannot reach it by path:
 *   - launchbot/  the Docker build context is the bot directory alone (`COPY . .`), so anything outside it is
 *                 simply absent from the image and the bot would crash on start.
 *   - pad/assets/ the site is served statically; a browser cannot import from a sibling source tree.
 *
 * So they get copies, and the copies are GENERATED, never hand-edited. `node scripts/sync-miner.mjs` refreshes them and
 * launchpad/test/miner-sync.test.js fails loudly if any copy has drifted — a silently stale copy would mine
 * addresses the factory never reaches, and the only symptom would be launches reverting BadTokenSuffix.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = join(root, "launchpad/mine/robin-mine.mjs");
export const COPIES = [join(root, "launchbot/mine/robin-mine.mjs"), join(root, "pad/assets/robin-mine.mjs")];

const BANNER = "// GENERATED COPY — do not edit. Source: launchpad/mine/robin-mine.mjs (node scripts/sync-miner.mjs).\n";

export function rendered() {
  return BANNER + readFileSync(SOURCE, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = rendered();
  for (const c of COPIES) {
    mkdirSync(dirname(c), { recursive: true });
    writeFileSync(c, out);
    console.log("wrote", c.slice(root.length + 1));
  }
}
