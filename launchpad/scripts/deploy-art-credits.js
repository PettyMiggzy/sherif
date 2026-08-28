// Deploy ArtCredits — the prepaid ledger in front of the pad's image generator.
//
//   cd launchpad
//   ROBINHOOD_RPC=<write-capable RPC> PRIVATE_KEY=<funded deployer> \
//     [USD_PER_CREDIT=0.10] [ETH_USD=3000] [OPERATOR=<indexer's relay address>] \
//     [PAY_TOKEN=<$ROBIN> TOKEN_PER_CREDIT=<wei> TOKEN_SINK=<staking pool>] \
//     npx hardhat run scripts/deploy-art-credits.js --network robinhood
//
// PRICING IS A GUESS THAT YOU FIX LATER, and that is fine — `setPrice` is one owner call. The
// contract holds a wei price rather than reading an oracle on purpose: an oracle would put a live
// external dependency in the purchase path, to price something that moves in cents.
const { ethers, network } = require("hardhat");

const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const USD_PER_CREDIT = Number(process.env.USD_PER_CREDIT || 0.10);
const ETH_USD = Number(process.env.ETH_USD || 3000);

// What each tier costs the customer, in credits. Mirrors the indexer's VENICE_CREDITS_* defaults —
// printed here so the deploy log states the actual retail prices rather than leaving them implied.
const TIERS = [["standard", 2], ["medium", 3], ["high", 6]];

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`Wrong chain ${net.chainId}, expected ${CHAIN_ID}. Set CHAIN_ID to override for a dry run.`);
  }
  if (!(USD_PER_CREDIT > 0) || !(ETH_USD > 0)) throw new Error("USD_PER_CREDIT and ETH_USD must both be positive.");

  // parseEther rather than float maths on wei: 0.10/3000 in double precision is not the number you
  // think it is, and a price is not a place to find that out.
  const weiPerCredit = ethers.parseEther((USD_PER_CREDIT / ETH_USD).toFixed(18));
  if (weiPerCredit === 0n) throw new Error("Price rounds to zero wei — check USD_PER_CREDIT / ETH_USD.");

  let gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  if (gasPrice == null) gasPrice = BigInt(await ethers.provider.send("eth_gasPrice", []));
  const ov = { type: 0, gasPrice }; // legacy: Orbit L2, no EIP-1559

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`network=${network.name} chain=${net.chainId}`);
  console.log(`deployer=${deployer.address} balance=${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) throw new Error("Deployer has 0 ETH — fund it first.");
  console.log(`price: $${USD_PER_CREDIT}/credit at $${ETH_USD}/ETH = ${weiPerCredit} wei (${ethers.formatEther(weiPerCredit)} ETH)\n`);

  const c = await (await ethers.getContractFactory("ArtCredits")).deploy(deployer.address, weiPerCredit, ov);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("ArtCredits:", addr);

  // The operator is the indexer's relay key. It is set here rather than left for later because an
  // unset operator means the generator cannot charge — and it fails by giving art away, not by
  // erroring, so nobody notices until the bill arrives.
  const operator = (process.env.OPERATOR || "").trim();
  if (operator) {
    if (!ethers.isAddress(operator)) throw new Error(`OPERATOR is not an address: ${operator}`);
    await (await c.setOperator(operator, true, ov)).wait();
    console.log("  operator:  ", operator);
  } else {
    console.log("  operator:   NOT SET — /api/art cannot charge until you call setOperator(<relay>, true)");
  }

  const payToken = (process.env.PAY_TOKEN || "").trim();
  if (payToken) {
    const perCredit = BigInt(process.env.TOKEN_PER_CREDIT || "0");
    const sink = (process.env.TOKEN_SINK || "").trim();
    if (!ethers.isAddress(payToken)) throw new Error("PAY_TOKEN is not an address.");
    if (!ethers.isAddress(sink)) throw new Error("TOKEN_SINK is required with PAY_TOKEN (where the tokens go).");
    if (perCredit === 0n) throw new Error("TOKEN_PER_CREDIT must be non-zero.");
    await (await c.setPayToken(payToken, perCredit, sink, ov)).wait();
    console.log(`  pay token:  ${payToken} @ ${perCredit}/credit -> ${sink}`);
  }

  // Read it all back. Every one of these is silent when wrong: a zero price sells credits for
  // nothing, and a missing operator gives art away.
  const [price, op2, owner] = await Promise.all([c.weiPerCredit(), operator ? c.isOperator(operator) : true, c.owner()]);
  if (price !== weiPerCredit) throw new Error("Price did not stick — refusing to report success.");
  if (!op2) throw new Error("Operator did not stick — refusing to report success.");
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error("Owner is not the deployer.");
  console.log("  verified:   price set, operator authorised, owned by deployer");

  console.log("\nRetail prices at this credit price:");
  for (const [name, n] of TIERS) {
    console.log(`  ${name.padEnd(9)} ${n} credits = $${(n * USD_PER_CREDIT).toFixed(2)} = ${ethers.formatEther(weiPerCredit * BigInt(n))} ETH`);
  }

  console.log("\nPaste into pad/assets/config.js CONTRACTS:");
  console.log(`  artCredits: "${addr}",`);
  console.log("\nAnd into indexer/.env:");
  console.log(`  ART_CREDITS=${addr}`);
  console.log(`  ART_OPERATOR_KEY=<the private key for ${operator || "<your relay address>"}>`);
  console.log("\nThen: fund the operator with a little gas — it pays for every charge — and confirm");
  console.log("GET /api/art/enabled reports paid:true. Until it does the generator is FREE.");
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
