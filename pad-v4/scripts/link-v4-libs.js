#!/usr/bin/env node
/*
 * Uniswap's v4 npm packages import their Foundry deps via remappings
 * (`solmate/`, `forge-std/`, `permit2/`) that Hardhat's node-style resolver cannot
 * follow on its own. Those deps ARE shipped, vendored under each package's `lib/`.
 * This script exposes them as resolvable node modules by creating a real forwarder
 * directory `node_modules/<name>/` with a minimal package.json plus a symlink to the
 * vendored source for each top-level entry — so `import "solmate/utils/X.sol"` resolves.
 *
 * Idempotent. Wired to `postinstall` so a fresh `npm install` reproduces it.
 */
const fs = require("fs");
const path = require("path");

const NM = path.join(__dirname, "..", "node_modules");

// name => vendored source root. The published v4 packages import `solmate/src/...` and
// `permit2/src/...` (lib ROOT, which contains `src/`) but `forge-std/...` (its `src/` directly).
const LIBS = {
  solmate: path.join(NM, "@uniswap/v4-core/lib/solmate"),
  "forge-std": path.join(NM, "@uniswap/v4-core/lib/forge-std/src"),
  permit2: path.join(NM, "@uniswap/v4-periphery/lib/permit2"),
};

function link(name, srcRoot) {
  if (!fs.existsSync(srcRoot)) {
    console.warn(`[link-v4-libs] skip ${name}: source not found at ${srcRoot}`);
    return;
  }
  const dest = path.join(NM, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify({ name, version: "0.0.0", private: true, description: "hardhat forwarder for v4 vendored lib" }, null, 2)
  );
  for (const entry of fs.readdirSync(srcRoot)) {
    if (entry === "package.json") continue;
    try {
      fs.symlinkSync(path.join(srcRoot, entry), path.join(dest, entry), "junction");
    } catch (e) {
      // fall back to a copy if symlinks are unavailable
      fs.cpSync(path.join(srcRoot, entry), path.join(dest, entry), { recursive: true });
    }
  }
  console.log(`[link-v4-libs] linked ${name} -> ${path.relative(NM, srcRoot)}`);
}

for (const [name, src] of Object.entries(LIBS)) link(name, src);
