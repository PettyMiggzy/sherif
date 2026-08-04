// LIVE end-to-end smoke for the disperser — real txs on Robinhood Chain, so you don't
// have to click a browser to prove it works. Costs only gas (a few cents on this L2) and
// moves NO real value: it deploys a throwaway test token and disperses that.
//
//   cd launchpad
//   PRIVATE_KEY=<funded deployer> ROBINHOOD_RPC=<write-capable rpc> \
//     npx hardhat run scripts/e2e-disperse-live.js --network robinhood
//
// Env:
//   DISPERSE_ADDR   (optional) an already-deployed Disperse to test; else it deploys a fresh one
//   SEND_ETH=1      (optional) also test disperseEther with a tiny real ETH amount (~0.0002 ETH)
//
// What it proves ON-CHAIN, with the exact legacy (type-0) txs the pad uses:
//   1. Disperse deploys (or the given one is reachable)
//   2. approve -> disperseTokenDirect splits a token to multiple wallets in one tx
//   3. recipients actually received their exact amounts; the helper held nothing
//   4. (optional) disperseEther pays out + refunds the remainder
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;

async function legacyOv(provider) {
  let gasPrice = (await provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gasPrice (legacy chain expected)");
  try { const b = await provider.getBlock("latest"); const f = ((b?.baseFeePerGas ?? 0n) * 12n) / 10n; if (f > gasPrice) gasPrice = f; } catch {}
  return { type: 0, gasPrice };
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`FAIL ${m}: got ${a}, want ${b}`); console.log("  ok:", m); };

async function main() {
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== 4663) throw new Error(`Wrong chain: ${net.chainId}, expected 4663. Aborting.`);
  const [dev] = await ethers.getSigners();
  const ov = await legacyOv(ethers.provider);
  console.log("Deployer:", dev.address, "| chain 4663 | gasPrice", ov.gasPrice.toString());

  // 1. Disperse (deploy fresh, or use DISPERSE_ADDR)
  let disperse;
  if (process.env.DISPERSE_ADDR) {
    disperse = await ethers.getContractAt("Disperse", process.env.DISPERSE_ADDR);
    console.log("Using existing Disperse:", process.env.DISPERSE_ADDR);
  } else {
    disperse = await (await ethers.getContractFactory("Disperse")).deploy(ov);
    await disperse.waitForDeployment();
    console.log("Deployed Disperse:", await disperse.getAddress());
  }
  const dAddr = await disperse.getAddress();

  // 2. Throwaway token (no real value) minted to the deployer, to test the token path safely.
  const tok = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE, ov);
  await tok.waitForDeployment();
  const tAddr = await tok.getAddress();
  console.log("Throwaway test token:", tAddr);

  // 3. approve(sum) -> disperseTokenDirect to 3 wallets (mirrors a 6-wallet dev-buy split, larger here)
  const recips = ["0x000000000000000000000000000000000000dEaD",
                  "0x00000000000000000000000000000000DeaDbeEf",
                  "0x0000000000000000000000000000000000C0FFEE"];
  const vals = [1234n * ONE, 5678n * ONE, 9010n * ONE];   // arbitrary large amounts — proves no value cap
  const total = vals.reduce((s, v) => s + v, 0n);

  console.log("approve...");
  await (await tok.approve(dAddr, total, ov)).wait();
  console.log("disperseTokenDirect...");
  await (await disperse.disperseTokenDirect(tAddr, recips, vals, ov)).wait();

  eq((await tok.balanceOf(recips[0])).toString(), vals[0].toString(), "recipient 0 got its amount");
  eq((await tok.balanceOf(recips[1])).toString(), vals[1].toString(), "recipient 1 got its amount");
  eq((await tok.balanceOf(recips[2])).toString(), vals[2].toString(), "recipient 2 got its amount");
  eq((await tok.balanceOf(dAddr)).toString(), "0", "Disperse held nothing (non-custodial)");

  // 4. optional ETH path (moves a tiny real amount)
  if (process.env.SEND_ETH === "1") {
    const eVals = [ethers.parseEther("0.0001"), ethers.parseEther("0.0001")];
    const eTotal = eVals[0] + eVals[1];
    const over = eTotal + ethers.parseEther("0.00005"); // overpay -> must refund
    const b0 = await ethers.provider.getBalance(recips[0]);
    console.log("disperseEther (tiny)...");
    await (await disperse.disperseEther([recips[0], recips[1]], eVals, { ...ov, value: over })).wait();
    const b0after = await ethers.provider.getBalance(recips[0]);
    eq((b0after - b0).toString(), eVals[0].toString(), "ETH recipient 0 received its amount");
    eq((await ethers.provider.getBalance(dAddr)).toString(), "0", "Disperse holds no ETH (refunded remainder)");
  }

  console.log("\nLIVE E2E PASSED. Disperse:", dAddr,
    process.env.DISPERSE_ADDR ? "(existing)" : "(deploy this one, or redeploy for prod)");
  console.log("If you deployed a fresh Disperse here, set CONTRACTS.disperse to", dAddr, "in pad/assets/config.js + verify it.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
