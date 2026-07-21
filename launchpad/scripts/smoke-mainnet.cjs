/* eslint-disable no-console */
// MAINNET SMOKE TEST — prove the DEPLOYED contracts actually work on Robinhood Chain BEFORE you register name
// tags or announce. It reads the LIVE addresses out of pad/assets/config.js and, using your deployer key:
//   1. launches a throwaway coin with a tiny dev buy  → proves token deploy + REAL Uniswap v3 pool + the swap path
//   2. (optional, TRADE=1) after the anti-snipe window, does a router buy + sell → proves the live trade path
//
//   cd launchpad
//   npx hardhat run scripts/smoke-mainnet.cjs --network robinhood
//   # also test a live buy+sell (waits out the anti-snipe window, a few minutes):
//   #   $env:TRADE=1 ; npx hardhat run scripts/smoke-mainnet.cjs --network robinhood
//
// Costs a little ETH (a ~13M-gas launch + the dev buy). The "SMOKE" coin is disposable — ignore it afterward.
// If anything fails here, you fix + REDEPLOY *before* tags/announcement, so nobody ever sees a dead contract.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const LAUNCH_GAS = 16_000_000n; // under Robinhood's 2^24 per-tx cap; estimateGas overshoots so we set it explicitly
const TRADE_GAS = 3_000_000n;

function readAddr(cfg, key) {
  const m = cfg.match(new RegExp(`\\b${key}:\\s*"(0x[0-9a-fA-F]{40})"`));
  return m ? m[1] : null;
}

async function main() {
  const [me] = await ethers.getSigners();
  const cfgPath = path.resolve(__dirname, "..", "..", "pad", "assets", "config.js");
  const cfg = fs.readFileSync(cfgPath, "utf8");
  const padFactory = readAddr(cfg, "padFactory");
  const padRouter = readAddr(cfg, "padRouter");
  if (!padFactory || !padRouter) throw new Error("padFactory / padRouter not filled into pad/assets/config.js — run the deploy first.");

  const bal = await ethers.provider.getBalance(me.address);
  console.log(`smoke tester = ${me.address}   balance = ${ethers.formatEther(bal)} ETH`);
  console.log(`padFactory   = ${padFactory}`);
  console.log(`padRouter    = ${padRouter}\n`);

  const factory = await ethers.getContractAt([
    "function launch((string name,string symbol,address dev,(uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,address projectWallet) tax) p) payable returns (address token,address curve,address pool)",
    "event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)",
  ], padFactory);

  // 1) LAUNCH (+ a tiny dev buy so the swap path runs too; the dev buy is anti-snipe-exempt)
  const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: me.address };
  const params = { name: "Smoke Test", symbol: "SMOKE", dev: me.address, tax };
  const devBuy = ethers.parseEther(process.env.DEV_BUY || "0.001");
  console.log(`> launching a throwaway coin with a ${ethers.formatEther(devBuy)} ETH dev buy ...`);
  const rc = await (await factory.launch(params, { value: devBuy, gasLimit: LAUNCH_GAS })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "Launched");
  if (!ev) throw new Error("no Launched event — the launch did not complete as expected");
  const { token, curve, pool } = ev.args;
  console.log(`  OK  launch gas=${rc.gasUsed}`);
  console.log(`      token=${token}`);
  console.log(`      curve=${curve}`);
  console.log(`      pool =${pool}`);

  const p = await ethers.getContractAt([
    "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
    "function liquidity() view returns (uint128)",
  ], pool);
  const slot0 = await p.slot0();
  const liq = await p.liquidity();
  if (slot0.sqrtPriceX96 === 0n || liq === 0n) throw new Error("pool is not a live/initialized Uniswap v3 pool");
  console.log(`  OK  real Uniswap v3 pool live (sqrtPriceX96=${slot0.sqrtPriceX96}, liquidity=${liq})`);

  const erc = await ethers.getContractAt([
    "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
  ], token);
  const [devBal, sym, sup] = await Promise.all([erc.balanceOf(me.address), erc.symbol(), erc.totalSupply()]);
  if (devBal === 0n) throw new Error("dev buy delivered 0 tokens — the swap path did not work");
  console.log(`  OK  dev buy delivered ${ethers.formatUnits(devBal, 18)} ${sym}  (supply ${ethers.formatUnits(sup, 18)})`);

  console.log(`\n==> CORE SMOKE PASSED: launch + real Uniswap v3 pool + dev-buy swap all work on Robinhood Chain.`);
  console.log(`    explorer: https://robinhoodchain.blockscout.com/token/${token}`);

  if (process.env.TRADE === "1") {
    const tok = await ethers.getContractAt([
      "function windowEndsAt() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], token);
    const winEnd = Number(await tok.windowEndsAt());
    const wait = Math.max(0, winEnd - Math.floor(Date.now() / 1000)) + 5;
    console.log(`\n> TRADE test: waiting ${wait}s for the anti-snipe window to expire, then a live buy + sell ...`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    const router = await ethers.getContractAt([
      "function buy(address,uint256) payable returns (uint256)",
      "function sell(address,uint256,uint256) returns (uint256)",
    ], padRouter);
    const b0 = await tok.balanceOf(me.address);
    const brc = await (await router.buy(token, 0n, { value: ethers.parseEther("0.001"), gasLimit: TRADE_GAS })).wait();
    const got = (await tok.balanceOf(me.address)) - b0;
    if (got === 0n) throw new Error("router buy delivered 0 tokens");
    console.log(`  OK  buy  gas=${brc.gasUsed}  got ${ethers.formatUnits(got, 18)} tokens`);
    await (await tok.approve(padRouter, got, { gasLimit: 200_000n })).wait();
    const src = await (await router.sell(token, got, 0n, { gasLimit: TRADE_GAS })).wait();
    console.log(`  OK  sell gas=${src.gasUsed}`);
    console.log(`\n==> FULL SMOKE PASSED: launch + buy + sell all work live. Safe to get name tags + announce.`);
  } else {
    console.log(`    (set TRADE=1 to also test a live router buy+sell after the anti-snipe window)`);
  }
}
main().catch((e) => { console.error("\n✗ SMOKE FAILED:", e.shortMessage || e.message || e); process.exit(1); });
