// Measure what a dev buy actually gets on the LIVE V3 curve (mainnet fork), deploy params.
// Run: FORK_RPC=https://rpc.mainnet.chain.robinhood.com STM=201600 CW=23000 MGW=22800 npx hardhat run scripts/dev-buy-calib.js
const { ethers } = require("hardhat");
const Q96 = 2n ** 96n;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ETH_USD = Number(process.env.ETH_USD || 1900);
const STM = BigInt(process.env.STM || 201600), CW = Number(process.env.CW || 23000), MGW = Number(process.env.MGW || 22800);

async function main() {
  const [dep, platform, dev, buyer] = await ethers.getSigners();
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3FACTORY, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, STM, CW, MGW);
  await (await router.setFactory(await factory.getAddress())).wait();
  const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

  console.log(`V3 curve (mainnet fork): STM=${STM} CW=${CW} | 1B supply, 75% curve, ETH=$${ETH_USD}`);
  for (const e of ["0.5", "1", "2"]) {
    const rc = await (await factory.launch({ name: "Cal", symbol: "CAL", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Launched");
    const { token, pool: poolAddr } = ev.args;
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const TOK = await ethers.getContractAt("LaunchToken", token);
    const t0 = token.toLowerCase() < WETH.toLowerCase();
    const fdv = (sqrtP) => { const p = (Number(sqrtP) / Number(Q96)) ** 2; return (t0 ? p : 1 / p) * 1e9 * ETH_USD; };
    if (BigInt(e === "0.5" ? 1 : 0)) {} // no-op
    const start = fdv((await pool.slot0()).sqrtPriceX96);
    await ethers.provider.send("evm_increaseTime", [600]); await ethers.provider.send("evm_mine", []);
    const before = await TOK.balanceOf(buyer.address);
    await (await router.connect(buyer).buy(token, 0n, { value: ethers.parseEther(e) })).wait();
    const got = Number(await TOK.balanceOf(buyer.address) - before) / 1e18;
    const mc = fdv((await pool.slot0()).sqrtPriceX96);
    console.log(`  start MC $${Math.round(start).toLocaleString()} | buy ${e} ETH -> ${(got / 1e6).toFixed(1)}M tokens = ${(got / 1e9 * 100).toFixed(1)}% supply | MC after $${Math.round(mc).toLocaleString()}`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
