/* eslint-disable no-console */
// Verify ONE launched coin's contracts on Sourcify → Blockscout shows them verified.
//
//   node scripts/verify-coin.cjs <token> [curve] [bond]
//
// - <token>  (required): the LaunchToken address.
// - [curve]  (optional): the CurvePool address. If omitted we read it from the token's on-chain wiring
//                        via the factory record (needs RPC_URL + FACTORY, else pass it explicitly).
// - [bond]   (optional): the Bond address (only exists after graduation).
//
// Runs against the current build artifacts, so compile first if you changed the contracts. Uses
// Blockscout's native verifier (it holds the on-chain bytecode; no API key, no constructor args needed —
// Blockscout auto-detects them from the creation tx). The verifier can be flaky under load; we retry.
const { BLOCKSCOUT, COIN_KINDS, verifyAddress } = require("./lib/blockscout.cjs");

async function main() {
  const [token, curve, bond] = process.argv.slice(2);
  if (!token) {
    console.error("usage: node scripts/verify-coin.cjs <token> [curve] [bond]");
    process.exit(2);
  }
  const jobs = [{ addr: token, ...COIN_KINDS.token, label: "token" }];
  if (curve) jobs.push({ addr: curve, ...COIN_KINDS.curve, label: "curve" });
  if (bond) jobs.push({ addr: bond, ...COIN_KINDS.bond, label: "bond" });

  console.log(`Verifying ${jobs.length} contract(s) for coin ${token} on Sourcify…\n`);
  const results = await Promise.all(jobs.map((j) => verifyAddress(j).catch(() => "fail")));
  const good = results.filter((r) => r === "ok" || r === "already").length;
  console.log(`\ndone: ${good}/${jobs.length} verified. explorer: ${BLOCKSCOUT}/address/${token}`);
  process.exit(good === jobs.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
