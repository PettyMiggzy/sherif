// Simulate the ACTUAL launch curve on a mainnet fork: launch a coin via the LIVE
// factory, then measure (via router.buy staticCall) how much ETH it costs to buy
// 2/5/10/20% of supply right after the anti-snipe window — plus the price impact.
// Run: FORK_RPC=<rpc> npx hardhat run scripts/sim-tenpct.js
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE;
const FACTORY = "0x44855d49E73Ad103Df51871A072FEe8709E6A2d6"; // live CurvePadFactory
const ROUTER  = "0xAEFE708e04D3E2e9609e6bC987903b31818C2a46"; // live PadRouter
const ETH_USD = 1900;

const fmtE = (w) => (Number(w) / 1e18);
const usd = (w) => "$" + Math.round(fmtE(w) * ETH_USD).toLocaleString();

async function main() {
  const [me, dev] = await ethers.getSigners();
  const factory = await ethers.getContractAt("CurvePadFactory", FACTORY);
  const router  = await ethers.getContractAt("PadRouter", ROUTER);

  // permissionless launch, plain 1% tax both sides
  const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
  const rc = await (await factory.launch({ name: "SimCoin", symbol: "SIM", dev: dev.address, tax })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Launched");
  const { token, curve, pool: poolAddr } = ev.args;
  const curveC = await ethers.getContractAt("CurvePool", curve);
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

  // warp past the opening anti-snipe window so a single large buy is allowed
  await ethers.provider.send("evm_increaseTime", [600]);
  await ethers.provider.send("evm_mine", []);

  const price0 = (await pool.slot0()).sqrtPriceX96;
  // FDV proxy: read curve mcap if available, else derive from sqrtPrice later. We report
  // price impact as the FDV multiple (sqrtPrice ratio squared).
  const fdvAt = (sqrtP) => {
    // FDV(now)/FDV(launch) = (sqrtP/price0)^2 ; launch FDV computed from curve raise anchors below
    const r = Number(sqrtP) / Number(price0);
    return r * r;
  };

  // binary-search the ETH `value` whose router.buy returns >= target tokens
  async function costFor(targetTokens) {
    let lo = 0n, hi = ethers.parseEther("6");
    // ensure hi is enough
    for (let i = 0; i < 40; i++) {
      const out = await router.buy.staticCall(token, 0n, { value: hi });
      if (out >= targetTokens) break; hi *= 2n;
    }
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2n;
      const out = await router.buy.staticCall(token, 0n, { value: mid });
      if (out >= targetTokens) hi = mid; else lo = mid;
    }
    return hi;
  }

  console.log("\n  Actual launch-curve simulation (live factory, mainnet fork)\n");
  console.log("  buy%      tokens        ETH cost (incl 1% fee)      ~USD");
  console.log("  ----------------------------------------------------------");
  const pcts = [2, 5, 10, 20];
  const rows = [];
  for (const p of pcts) {
    const target = (SUPPLY * BigInt(p)) / 100n;
    const cost = await costFor(target);
    rows.push({ p, target, cost });
    console.log(`  ${String(p).padStart(3)}%   ${(fmtE(target)/1e6).toFixed(0).padStart(4)}M tok     ${fmtE(cost).toFixed(4).padStart(8)} ETH            ${usd(cost).padStart(9)}`);
  }

  // execute the 10% buy for real to read the resulting price / FDV multiple
  const ten = rows.find((r) => r.p === 10);
  await (await router.buy(token, 0n, { value: ten.cost })).wait();
  const price1 = (await pool.slot0()).sqrtPriceX96;
  console.log("\n  Price impact of the 10% buy:");
  console.log(`    FDV moved ~${fdvAt(price1).toFixed(2)}x from launch (sqrtPrice ${price0} -> ${price1})`);
  const bal = await (await ethers.getContractAt("LaunchToken", token)).balanceOf(me.address);
  console.log(`    tokens actually received: ${(fmtE(bal)/1e6).toFixed(1)}M (${(fmtE(bal)/1e9*100).toFixed(2)}% of supply)`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
