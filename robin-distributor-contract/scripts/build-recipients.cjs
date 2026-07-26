// Build recipients.json from recipients.txt — validated (EIP-55), de-duped, capped
// at 1000. Used by the ops scripts and the test.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const root = path.join(__dirname, "..");
const srcTxt = path.join(root, "recipients.txt");
const outJson = path.join(root, "recipients.json");

const raw = fs.readFileSync(srcTxt, "utf8");
const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const seen = new Set();
const out = [];
const problems = [];
let dupes = 0;

for (let i = 0; i < lines.length; i++) {
  const a = lines[i];
  if (!ethers.isAddress(a)) { problems.push(`line ${i + 1}: invalid address: ${a}`); continue; }
  let c;
  try { c = ethers.getAddress(a); } catch { problems.push(`line ${i + 1}: bad checksum: ${a}`); continue; }
  const key = c.toLowerCase();
  if (seen.has(key)) { dupes++; continue; }
  seen.add(key);
  out.push(c);
}

if (problems.length) {
  console.error(`✗ ${problems.length} bad line(s):`);
  problems.slice(0, 50).forEach((p) => console.error("  " + p));
  process.exit(1);
}

const CAP = 1000;
const capped = out.length > CAP ? out.slice(0, CAP) : out;
if (out.length > CAP) console.warn(`! ${out.length} unique — capping at ${CAP}.`);

fs.writeFileSync(outJson, JSON.stringify(capped, null, 0) + "\n");
console.log(`✓ ${lines.length} lines → ${out.length} unique (${dupes} dup dropped) → wrote ${capped.length} to recipients.json`);
