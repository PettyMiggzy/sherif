/* eslint-disable no-console */
// Measures the graduation raise for candidate curve params on a fork (free). FORK_RPC in .env.
//   npx hardhat run scripts/calibrate.js
const { ethers } = require("hardhat");
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;

const CANDIDATES = [
  { startMag: 252400, width: 4000 },
  { startMag: 246000, width: 4000 },
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
  return { spent, ready };
}

async function main() {
  for (const c of CANDIDATES) {
    const { spent, ready } = await measure(c.startMag, c.width);
    console.log(`startMag=${c.startMag} width=${c.width} -> graduation raise ≈ ${ethers.formatEther(spent)} ETH  (~$${(Number(ethers.formatEther(spent)) * 1920).toFixed(2)}), ready=${ready}`);
  }
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
