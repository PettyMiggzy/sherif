/* eslint-disable no-console */
// Measures the graduation raise for candidate curve params on a fork (free). FORK_RPC in .env.
//   npx hardhat run scripts/calibrate.js
const { ethers } = require("hardhat");
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;

const ETH_USD = 1920;
// Targeting graduation FDV ~$30k with a ~3 ETH raise. grad FDV = startFDV * 1.0001^width, so a smaller
// startMag (higher start price) + a narrower width both pull grad mcap down from the old ~$69k.
// Targeting a ~4 ETH raise at ~$30k grad FDV. All keep gradTick ≈ -179800 (so grad mcap stays ~$30k); a
// smaller startMag = higher start price = bigger raise. width = startMag - 179800.
const CANDIDATES = [
  { startMag: 202400, width: 22600 }, // est ~3.85 ETH
  { startMag: 201600, width: 21800 }, // est ~4.0 ETH
  { startMag: 200800, width: 21000 }, // est ~4.15 ETH
];

async function measure(startMag, width) {
  const [dep, platform, dev, buyer] = await ethers.getSigners();
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), startMag, width
  );
  await (await router.setFactory(await factory.getAddress())).wait();
  const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
  const rc = await (await factory.launch({ name: "T", symbol: "T", dev: dev.address, tax: NOTAX })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  const { token, curve, pool: poolAddr } = ev.args;
  const curveC = await ethers.getContractAt("CurvePool", curve);

  // past the anti-snipe window, then buy out the curve capped at the graduation price
  await ethers.provider.send("evm_increaseTime", [400]);
  await ethers.provider.send("evm_mine", []);
  const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
  const wethW = await ethers.getContractAt(["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
  await (await wethW.connect(buyer).deposit({ value: 20n * ONE })).wait();
  await (await wethW.connect(buyer).approve(await probe.getAddress(), 20n * ONE)).wait();
  const before = await wethW.balanceOf(buyer.address);
  await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 20n * ONE, await curveC.gradSqrtPriceX96())).wait();
  const spent = before - (await wethW.balanceOf(buyer.address));
  const ready = await curveC.ready();

  // graduation FDV: read the spot price at the curve top and value the full 1e9 supply
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
  const sqrtP = (await pool.slot0()).sqrtPriceX96;
  const tokenIsToken0 = BigInt(token) < BigInt(WETH);
  // price(token1/token0) = (sqrtP/2^96)^2, computed in floating point (calibration only)
  const s = Number(sqrtP) / 2 ** 96;
  const p01 = s * s;
  const wethPerToken = tokenIsToken0 ? p01 : 1 / p01; // WETH per 1 token
  const gradFdvEth = wethPerToken * 1e9; // 1e9 whole tokens
  return { spent, ready, gradFdvEth };
}

async function main() {
  for (const c of CANDIDATES) {
    const { spent, ready, gradFdvEth } = await measure(c.startMag, c.width);
    const raiseEth = Number(ethers.formatEther(spent));
    console.log(
      `startMag=${c.startMag} width=${c.width} -> raise ≈ ${raiseEth.toFixed(3)} ETH (~$${(raiseEth * ETH_USD).toFixed(0)}), ` +
      `grad FDV ≈ ${gradFdvEth.toFixed(2)} ETH (~$${(gradFdvEth * ETH_USD / 1000).toFixed(1)}k), ready=${ready}`
    );
  }
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
