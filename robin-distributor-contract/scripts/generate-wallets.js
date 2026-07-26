// Generate a fresh pool of trading wallets — RUN THIS ON THE DROPLET so the
// private keys are created on your server and never touch git or chat.
//
//   WALLET_COUNT=8000 node scripts/generate-wallets.js
//
// Writes (both gitignored, so `git pull` never conflicts):
//   keys.json          — [{address, privateKey}]  ← SECRET, the pool the autopilot uses
//   pool-addresses.json — [address, …]            ← addresses only, safe to eyeball/share
//
// 8,000 wallets is enough for a single ~$100 deposit at the floor buy amount to
// give ~1 buy per wallet (max distinct buyers). Wallets are reused across future
// deposits, so you only generate once. (This does NOT touch recipients.json.)
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const N = Number(process.env.WALLET_COUNT || process.argv[2] || 8000);
const KEYS = path.join(ROOT, "keys.json");
const RECIPS = path.join(ROOT, "pool-addresses.json");

if (!Number.isInteger(N) || N < 1 || N > 200000) throw new Error(`WALLET_COUNT out of range: ${N}`);

if (fs.existsSync(KEYS)) {
  // Never silently overwrite existing keys (funds could be sitting in them).
  const bak = `${KEYS}.bak-${Date.now()}`;
  fs.copyFileSync(KEYS, bak);
  console.log(`⚠  keys.json already exists — backed up to ${path.basename(bak)} before regenerating.`);
}

console.log(`Generating ${N} wallets…`);
const keys = new Array(N);
const addrs = new Array(N);
for (let i = 0; i < N; i++) {
  let w;
  // randomBytes(32) is essentially always a valid secp256k1 key; retry on the
  // astronomically unlikely out-of-range value.
  for (;;) {
    try { w = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32))); break; } catch { /* retry */ }
  }
  keys[i] = { address: w.address, privateKey: w.privateKey };
  addrs[i] = w.address;
  if ((i + 1) % 1000 === 0) console.log(`  …${i + 1}/${N}`);
}

fs.writeFileSync(KEYS, JSON.stringify(keys));
fs.writeFileSync(RECIPS, JSON.stringify(addrs));
try { fs.chmodSync(KEYS, 0o600); } catch { /* best effort */ }

console.log(`✓ wrote ${N} wallets:`);
console.log(`   ${KEYS}   (SECRET — keep on this server only; it's gitignored)`);
console.log(`   ${RECIPS} (addresses only — safe to share/commit)`);
console.log(`\nBack up keys.json somewhere safe. If you lose it, any ETH/tokens in these wallets are gone.`);
