// Calibrate the launch curve. Deploys a FRESH factory on a mainnet fork with the
// given tick params, then measures what actually matters:
//   - cost to buy 2% / 5% / 10% at the open (USD)
//   - min-graduation: FDV, ETH raised, % supply sold
//   - the 0.5-ETH reward per side and what's left for the floor
//   - the ceiling FDV
// Params via env: STM (START_TICK_MAG), CW (CURVE_WIDTH), MGW (MIN_GRAD_WIDTH).
// Run: FORK_RPC=<rpc> STM=207400 CW=35800 MGW=22000 npx hardhat run scripts/calibrate-curve.js
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ETH_USD = 1900;
const Q96 = 2n ** 96n;

const STM = BigInt(process.env.STM || 196200);
const CW  = Number(process.env.CW  || 25800);
const MGW = Number(process.env.MGW || 16400);

const eth = (w) => Number(w) / 1e18;
const usd = (w) => "$" + Math.round(eth(w) * ETH_USD).toLocaleString();

async function main() {
  const [dep, platform, dev, buyer] = await ethers.getSigners();
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd  = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3FACTORY, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), STM, CW, MGW
  );
  await (await router.setFactory(await factory.getAddress())).wait();

  const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
  const rc = await (await factory.launch({ name: "Cal", symbol: "CAL", dev: dev.address, tax })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Launched");
  const { token, curve, pool: poolAddr } = ev.args;
  const curveC = await ethers.getContractAt("CurvePool", curve);
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
  const tokenIsToken0 = token.toLowerCase() < WETH.toLowerCase();

  // FDV (usd) from a sqrtPriceX96, accounting for token ordering
  const fdv = (sqrtP) => {
    const p1per0 = (Number(sqrtP) / Number(Q96)) ** 2;           // token1 per token0
    const wethPerToken = tokenIsToken0 ? p1per0 : 1 / p1per0;    // WETH per token
    return wethPerToken * 1e9 * ETH_USD;
  };
  const startFDV = fdv((await pool.slot0()).sqrtPriceX96);

  await ethers.provider.send("evm_increaseTime", [600]);
  await ethers.provider.send("evm_mine", []);

  // cost to buy a % of supply (router.buy staticCall binary search)
  async function costFor(target) {
    let lo = 0n, hi = ethers.parseEther("10");
    for (let i = 0; i < 40; i++) { if (await router.buy.staticCall(token, 0n, { value: hi }) >= target) break; hi *= 2n; }
    for (let i = 0; i < 56; i++) { const m = (lo + hi) / 2n; (await router.buy.staticCall(token, 0n, { value: m }) >= target) ? hi = m : lo = m; }
    return hi;
  }
  const c2 = await costFor(SUPPLY * 2n / 100n);
  const c5 = await costFor(SUPPLY * 5n / 100n);
  const c10 = await costFor(SUPPLY * 10n / 100n);

  // min-graduation: buy up to the min-grad price, measure raise + supply sold
  const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
  const wethW = await ethers.getContractAt(
    ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
  await (await wethW.connect(buyer).deposit({ value: 200n * ONE })).wait();
  await (await wethW.connect(buyer).approve(await probe.getAddress(), 200n * ONE)).wait();
  const TOK = await ethers.getContractAt("LaunchToken", token);
  const wBefore = await wethW.balanceOf(buyer.address);
  const minGrad = await curveC.minGradSqrtPriceX96();
  await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 200n * ONE, minGrad)).wait();
  const raise = wBefore - await wethW.balanceOf(buyer.address);
  const sold = await TOK.balanceOf(buyer.address);
  const mgFDV = fdv((await pool.slot0()).sqrtPriceX96);
  const gradCeil = fdv(await curveC.gradSqrtPriceX96());

  // 0.5 ETH reward per side is capped at raise/4; floor keeps the rest
  const HALF = ONE / 2n;
  const reward = raise / 4n < HALF ? raise / 4n : HALF;
  const floorKept = raise - 2n * reward;

  console.log(`\n  ── curve calibration ─────────────────────────────`);
  console.log(`  params: START_TICK_MAG=${STM}  CURVE_WIDTH=${CW}  MIN_GRAD_WIDTH=${MGW}`);
  console.log(`  start FDV:            ~$${Math.round(startFDV).toLocaleString()}`);
  console.log(`  buy 2%:   ${eth(c2).toFixed(4)} ETH  (${usd(c2)})   <-- target ~$40`);
  console.log(`  buy 5%:   ${eth(c5).toFixed(4)} ETH  (${usd(c5)})`);
  console.log(`  buy 10%:  ${eth(c10).toFixed(4)} ETH  (${usd(c10)})`);
  console.log(`  ── at minimum graduation ──`);
  console.log(`  min-grad FDV:        ~$${Math.round(mgFDV).toLocaleString()}`);
  console.log(`  raised to graduate:  ${eth(raise).toFixed(2)} ETH  (${usd(raise)})`);
  console.log(`  supply sold:         ${(eth(sold) / 1e9 * 100).toFixed(1)}%`);
  console.log(`  reward / side:       ${eth(reward).toFixed(3)} ETH  ${reward < HALF ? "(CAPPED below 0.5!)" : "(full 0.5)"}`);
  console.log(`  floor keeps:         ${eth(floorKept).toFixed(2)} ETH`);
  console.log(`  ceiling FDV:         ~$${Math.round(gradCeil).toLocaleString()}`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
