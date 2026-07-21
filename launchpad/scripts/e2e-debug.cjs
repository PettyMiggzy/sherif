/* eslint-disable no-console */
// Isolate the buy/graduate reverts seen in the E2E, at the CONTRACT level (in-process hardhat network — no
// UI, no proxy). Deploys the stack, launches a coin with a dev buy, then tries a router buy and a graduation,
// printing the exact revert for each step.  npx hardhat run scripts/e2e-debug.cjs
const { ethers } = require("hardhat");
const V3 = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

async function main() {
  const [dep] = await ethers.getSigners();
  const owner = dep.address;
  const D = async (n, ...a) => { const c = await (await ethers.getContractFactory(n)).deploy(...a); await c.waitForDeployment(); return c; };

  const weth = await D("MockWETH9");
  const v3 = await new ethers.ContractFactory(V3.abi, V3.bytecode, dep).deploy(); await v3.waitForDeployment();
  const WETH = await weth.getAddress(), V3FAC = await v3.getAddress();
  const ltd = await D("LaunchTokenDeployer"), cpd = await D("CurvePoolDeployer"), bd = await D("BondDeployer");
  const router = await D("PadRouter", WETH, owner);
  const factory = await D("CurvePadFactory", WETH, V3FAC, owner, owner, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207400, 38000, 27000);
  await (await router.setFactory(await factory.getAddress())).wait();
  const rv = await D("RewardVault", await router.getAddress(), owner, owner, 604800, 86400, 172800, 2592000, owner);
  await (await router.setRewardVault(await rv.getAddress())).wait();
  console.log("deployed. router=", await router.getAddress());

  // launch with a 0.5 ETH dev buy
  const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: owner };
  const params = { name: "Dbg", symbol: "DBG", dev: owner, tax };
  const rc = await (await factory.launch(params, { value: ethers.parseEther("0.5") })).wait();
  const token = await factory.allTokens(0);
  const rec = await factory.recordOf(token);
  const curve = await ethers.getContractAt([
    "function minGradTick() view returns (int24)", "function gradTick() view returns (int24)", "function gradTarget() view returns (int24)",
    "function setGradTarget(int24)", "function ready() view returns (bool)", "function graduated() view returns (bool)",
    "function bond() view returns (address)", "function pool() view returns (address)", "function graduate()",
  ], rec.curve);
  const tok = await ethers.getContractAt(["function windowEndsAt() view returns (uint256)", "function antiSnipeActive() view returns (bool)"], token);
  console.log("launched token=", token, "curve=", rec.curve, "launchGas=", rc.gasUsed.toString());
  // advance past the anti-snipe window so a normal trader can buy (guard auto-expires)
  const winEnd = Number(await tok.windowEndsAt());
  await ethers.provider.send("evm_setNextBlockTimestamp", [winEnd + 5]);
  await ethers.provider.send("evm_mine", []);
  console.log("advanced past anti-snipe window; active now=", await tok.antiSnipeActive());
  console.log("ticks: min=", (await curve.minGradTick()).toString(), "grad=", (await curve.gradTick()).toString(), "target=", (await curve.gradTarget()).toString(), "ready=", await curve.ready());

  const routerC = await ethers.getContractAt([
    "function buy(address token, uint256 minOut) payable returns (uint256)",
    "function configOf(address) view returns ((address pool,address curve,address projectWallet,uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,bool set))",
    "function rewardVault() view returns (address)",
  ], await router.getAddress());
  console.log("router.rewardVault=", await routerC.rewardVault());

  // (A) try a router buy with minOut=0
  try {
    const out = await routerC.buy.staticCall(token, 0n, { value: ethers.parseEther("0.05") });
    console.log("BUY staticCall OK → out=", out.toString());
    const brc = await (await routerC.buy(token, 0n, { value: ethers.parseEther("0.05") })).wait();
    console.log("BUY sent OK gas=", brc.gasUsed.toString());
  } catch (e) {
    console.log("BUY FAILED:", e.shortMessage || e.message);
    if (e.data) console.log("  revert data:", e.data);
  }

  // (B) climb to ready via minOut=0 buys, then graduate
  try {
    await (await curve.setGradTarget(await curve.minGradTick())).wait();
    console.log("setGradTarget(min) OK; target=", (await curve.gradTarget()).toString());
    let n = 0;
    while (!(await curve.ready()) && n < 40) { await (await routerC.buy(token, 0n, { value: ethers.parseEther("0.5") })).wait(); n++; }
    console.log("climbed", n, "buys; ready=", await curve.ready());
    const grc = await (await curve.graduate()).wait();
    console.log("GRADUATE OK gas=", grc.gasUsed.toString(), "→ graduated=", await curve.graduated(), "bond=", await curve.bond());
  } catch (e) {
    console.log("CLIMB/GRADUATE FAILED:", e.shortMessage || e.message);
    if (e.data) console.log("  revert data:", e.data);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
