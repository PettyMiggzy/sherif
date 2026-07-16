/* eslint-disable no-console */
// LIVE test step 1: launch a throwaway coin on the deployed test factory, verify DEX-day-one, buy + sell.
//   PAD_FACTORY=.. PAD_ROUTER=.. npx hardhat run scripts/livetest-launch.js --network robinhood
const { ethers } = require("hardhat");
const F = process.env.PAD_FACTORY, R = process.env.PAD_ROUTER;

async function main() {
  const [me] = await ethers.getSigners();
  console.log("tester:", me.address, "bal:", ethers.formatEther(await ethers.provider.getBalance(me.address)), "ETH\n");

  const factory = await ethers.getContractAt("CurvePadFactory", F);
  const router = await ethers.getContractAt("PadRouter", R);

  // launch with a 3% fee both sides so we can watch the whole split live (all project share -> wallet=me)
  const tax = { buyBps: 300, sellBps: 300, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: me.address };
  console.log("launching $TEST …");
  const rc = await (await factory.launch({ name: "Sheriff Test", symbol: "TEST", dev: me.address, tax })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  const { token, curve, pool } = ev.args;
  console.log("  token:", token, "\n  curve:", curve, "\n  pool :", pool);
  console.log("  DexScreener:", `https://dexscreener.com/robinhood/${pool}`);

  // DEX day one: it's a real, initialized Uniswap v3 pool from block one
  const p = await ethers.getContractAt("IUniswapV3Pool", pool);
  const TOK = await ethers.getContractAt("LaunchToken", token);
  const slot0 = await p.slot0();
  console.log(`\n  pool live: sqrtPriceX96=${slot0.sqrtPriceX96} tick=${slot0.tick}`);
  console.log(`  tradingEnabled=${await TOK.tradingEnabled()} antiSnipeActive=${await TOK.antiSnipeActive()} windowEndsAt=${await TOK.windowEndsAt()}`);

  // a small BUY through the router (native ETH, no approval). Tiny, to stay under the 1% opening wallet cap.
  const spend = ethers.parseEther("0.00004");
  console.log(`\n  buying with ${ethers.formatEther(spend)} ETH …`);
  await (await router.buy(token, 0, { value: spend })).wait();
  const bal = await TOK.balanceOf(me.address);
  console.log(`  got ${ethers.formatUnits(bal, 18)} TEST`);
  console.log(`  escrows -> platform=${await router.platformEscrow()} deferred=${await router.deferredEscrow(token)} sheriffCut=${await router.sheriffCutEscrow()} dev=${await router.devEscrow(token)}`);

  // a SELL back through the router (one exact-amount approval)
  const sellAmt = bal / 4n;
  await (await TOK.approve(R, sellAmt)).wait();
  const before = await ethers.provider.getBalance(me.address);
  const sr = await (await router.sell(token, sellAmt, 0)).wait();
  const after = await ethers.provider.getBalance(me.address);
  console.log(`\n  sold ${ethers.formatUnits(sellAmt, 18)} TEST -> net ETH change (incl gas) ${ethers.formatEther(after - before)}`);

  console.log(`\n=== for step 2 (after the window at ${await TOK.windowEndsAt()} unix) ===`);
  console.log(`  TEST_TOKEN=${token} TEST_CURVE=${curve} TEST_POOL=${pool}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
