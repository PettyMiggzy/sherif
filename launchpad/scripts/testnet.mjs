// One-command LOCAL testnet: boots a hardhat node forked from Robinhood Chain (real Uniswap v3 + WETH, but
// unlimited test ETH), deploys the full pad stack to it, and prints everything you need to click through the
// real frontend — config to paste, a funded test account to import, and next steps.
//
//   npm run testnet                 # real "let it ride" geometry (~2.5 ETH to graduate; you have 10,000)
//   TESTNET_CHEAP=1 npm run testnet # narrow geometry (~1.2 ETH to graduate) for fewer buys per lifecycle run
//
// NOTE: even the narrow curve graduates in ~1.2 ETH (the raise is dominated by supply-sold, not the tick width),
// so graduation is NOT reachable on a real 0.01-ETH/day faucet — that's exactly why you test here on a fork with
// unlimited ETH. Use the public testnet only for cheap-path smoke tests (launch tx, a small buy, wallet/RPC/UI).
//
// Requires FORK_RPC in launchpad/.env (an archive RPC for Robinhood Chain — the same one the fork tests use).
// Ctrl+C stops the node.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

// tiny .env reader (no dep) — only to find FORK_RPC if it isn't already exported
function envFromFile(k) {
  const p = resolve(root, ".env");
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i < 0) continue;
    if (t.slice(0, i).trim() === k) return t.slice(i + 1).trim();
  }
}

const FORK_RPC = process.env.FORK_RPC || envFromFile("FORK_RPC");
const PORT = process.env.TESTNET_PORT || "8545";
const RPC = `http://127.0.0.1:${PORT}`;
// Hardhat's built-in dev account #0 (public, well-known test key — safe to print; NEVER use on mainnet).
const ACCT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

if (!FORK_RPC) {
  console.error("\n✗ FORK_RPC is not set. The local node must FORK Robinhood Chain so it has the real Uniswap v3 + WETH.");
  console.error("  Add FORK_RPC=<your Robinhood Chain archive RPC> to launchpad/.env and re-run.\n");
  process.exit(1);
}

// Narrow geometry graduates in ~1.2 ETH (measured via scripts/calibrate-curve.js) — fewer buys to click through
// a full launch→trade→graduate→claim. Still ETH-scale (the curve sells ~38% of supply to graduate), so this is
// about SPEED of the local run, not fitting a faucet. Both presets are trivially affordable with 10,000 fork ETH.
const cheap = process.env.TESTNET_CHEAP === "1";
const geom = cheap
  ? { CURVE_WIDTH: "2000", MIN_GRAD_WIDTH: "1000" }
  : {};

const sh = (cmd, args, extraEnv = {}) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: root, shell: true, stdio: "inherit", env: { ...process.env, ...extraEnv } });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    p.on("error", rej);
  });

async function rpcUp() {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
    const j = await r.json(); return !!j.result;
  } catch { return false; }
}

console.log(`\n▸ booting hardhat node — forking Robinhood Chain via FORK_RPC …`);
const node = spawn("npx", ["hardhat", "node", "--fork", FORK_RPC, "--port", PORT], {
  cwd: root, shell: true, stdio: ["ignore", "pipe", "inherit"],
});
node.stdout.on("data", (d) => { if (/Started HTTP|JSON-RPC/.test(d.toString())) process.stdout.write("  " + d); });
const stop = () => { try { node.kill(); } catch {} };
process.on("SIGINT", () => { console.log("\n▸ stopping node — bye"); stop(); process.exit(0); });
process.on("exit", stop);

// wait for the RPC to answer
for (let i = 0; i < 120; i++) { if (await rpcUp()) break; await new Promise((r) => setTimeout(r, 500)); }
if (!(await rpcUp())) { console.error("✗ node did not come up on " + RPC); stop(); process.exit(1); }
console.log(`✓ node live at ${RPC}  (forked · 20 accounts × 10,000 ETH)\n`);

console.log(`▸ deploying the pad stack ${cheap ? "(narrow geometry — graduates in ~1.2 ETH)" : "(real geometry — graduates in ~2.5 ETH)"} …\n`);
try {
  await sh("npx", ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], geom);
} catch (e) {
  console.error("\n✗ deploy failed:", e.message); stop(); process.exit(1);
}

console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
  LOCAL TESTNET READY — click through the real frontend with unlimited ETH
╚══════════════════════════════════════════════════════════════════════════╝

 1. Paste the 5 addresses printed above into  pad/assets/config.js  (CONTRACTS).
    Also set  API_BASE = ""  (the pad reads chain directly; no indexer needed to click through).

 2. Point the pad's RPC at this node. In pad/assets/config.js CHAIN.rpc, use:
      ["${RPC}"]            (and CHAIN.id stays 4663 — it's a fork of mainnet)

 3. Serve the pad and open it:
      npx serve ../pad        (or any static server) → open the printed URL

 4. In your wallet (MetaMask/Phantom) add a network:
      RPC URL   ${RPC}
      Chain ID  4663
    Import this funded dev account (PUBLIC test key — local only, never mainnet):
      ${ACCT0}
      ${KEY0}

 5. Now do the full run: Launch a coin → buy up the curve → Graduate → open the
    admin panel (admin.html) and check fees/rewards. Graduation costs ${cheap ? "~1.2" : "~2.5"} ETH — you have 10,000.

 Node is running. Ctrl+C here stops it.
`);
