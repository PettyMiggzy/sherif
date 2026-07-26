// Dry-run the whole flow on a LOCAL EVM to measure real gas, then price it with
// the LIVE Robinhood Chain gas price + live ETH/USD. No real funds spent.
//   npx hardhat run scripts/estimate-gas.js
//
// Sends to fresh accounts include the 25k account-creation cost, so this is an
// UPPER BOUND — on-chain wallets that already exist cost less.
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("node:fs"), path = require("node:path");

const R = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "recipients.json"), "utf8")).map((a) => ethers.getAddress(a));
const LOAD_BATCH = Number(process.env.LOAD_BATCH || 200);
const DIST_BATCH = Number(process.env.DISTRIBUTE_BATCH || 200);

async function liveContext() {
  // Live gas price from the real chain.
  let gasPrice = ethers.parseUnits("0.1", "gwei"), gpSrc = "fallback 0.1 gwei";
  try {
    const p = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC || "https://robinhoodchain.blockscout.com/api/eth-rpc",
      { chainId: 4663, name: "rhc" }, { staticNetwork: true });
    const fee = await p.getFeeData();
    if (fee.gasPrice) { gasPrice = fee.gasPrice; gpSrc = "live chain"; }
  } catch { /* keep fallback */ }
  // Live ETH/USD.
  let ethUsd = null, pSrc = "n/a";
  try {
    if (process.env.ETH_USD) { ethUsd = Number(process.env.ETH_USD); pSrc = "ETH_USD env"; }
    else {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
      ethUsd = (await r.json())?.ethereum?.usd; pSrc = "coingecko";
    }
  } catch { /* price optional */ }
  return { gasPrice, gpSrc, ethUsd, pSrc };
}

async function main() {
  const { gasPrice, gpSrc, ethUsd, pSrc } = await liveContext();
  const INCREMENT_USD = Number(process.env.INCREMENT_USD || "0.0000814");
  const unit = ethUsd ? ethers.parseUnits((INCREMENT_USD / ethUsd).toFixed(18), 18) : ethers.parseUnits("0.00000004334", 18);

  const [owner] = await ethers.getSigners();
  const C = await ethers.getContractFactory("RobinDistributor");

  // deploy
  const dep = await C.deploy(unit);
  const depRc = await dep.deploymentTransaction().wait();
  await dep.waitForDeployment();
  const c = dep;

  // load
  let loadGas = 0n, loadTxs = 0;
  for (let i = 0; i < R.length; i += LOAD_BATCH) {
    const rc = await (await c.addRecipients(R.slice(i, i + LOAD_BATCH))).wait();
    loadGas += rc.gasUsed; loadTxs++;
  }

  // fund for ALL wallets, one step each
  const n = BigInt(R.length);
  const needForAll = unit * n;
  await (await owner.sendTransaction({ to: await c.getAddress(), value: needForAll })).wait();

  // fixed round: exactly one step each
  const startRc = await (await c.startFixedRound()).wait();
  let distGas = 0n, distTxs = 0;
  while (await c.roundActive()) {
    const rc = await (await c.distribute(DIST_BATCH)).wait();
    distGas += rc.gasUsed; distTxs++;
  }

  const oneTimeGas = depRc.gasUsed + loadGas;
  const perRunGas = startRc.gasUsed + distGas;
  const cost = (gas) => gas * gasPrice; // wei
  const eth = (wei) => ethers.formatEther(wei);
  const usd = (wei) => (ethUsd == null ? "—" : "$" + (Number(ethers.formatEther(wei)) * ethUsd).toFixed(4));
  const L = "─".repeat(70);

  console.log(L);
  console.log(`Recipients            ${n}`);
  console.log(`Increment ($${INCREMENT_USD}/wallet)  ${eth(unit)} ETH  ≈ ${usd(unit)}`);
  console.log(`ETH/USD               ${ethUsd == null ? "n/a" : "$" + ethUsd} (${pSrc})`);
  console.log(`Gas price             ${ethers.formatUnits(gasPrice, "gwei")} gwei (${gpSrc})`);
  console.log(L);
  console.log(`VALUE distributed     ${eth(needForAll)} ETH  ≈ ${usd(needForAll)}   (1000 × one step)`);
  console.log(L);
  console.log(`ONE-TIME setup gas    deploy ${depRc.gasUsed} + load ${loadGas} (${loadTxs} txs) = ${oneTimeGas}`);
  console.log(`  cost                ${eth(cost(oneTimeGas))} ETH  ≈ ${usd(cost(oneTimeGas))}`);
  console.log(L);
  console.log(`PER RUN gas           startRound ${startRc.gasUsed} + distribute ${distGas} (${distTxs} txs) = ${perRunGas}`);
  console.log(`  avg gas / wallet    ${perRunGas / n}`);
  console.log(`  gas cost            ${eth(cost(perRunGas))} ETH  ≈ ${usd(cost(perRunGas))}`);
  console.log(L);
  const totalFirstRun = cost(oneTimeGas) + cost(perRunGas);
  console.log(`FUND THE CONTRACT     ${eth(needForAll)} ETH  ≈ ${usd(needForAll)}   (the value being sent out)`);
  console.log(`FUND YOUR WALLET (gas) first run  ${eth(totalFirstRun)} ETH ≈ ${usd(totalFirstRun)}` +
              `   | later runs ${eth(cost(perRunGas))} ETH ≈ ${usd(cost(perRunGas))}`);
  console.log(L);
  console.log(`Note: fresh-account creation (25k gas/wallet) is included — an UPPER BOUND.`);
  console.log(`      Wallets that already exist on-chain cost less. Live run prints real gas per batch.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
