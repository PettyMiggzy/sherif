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
  // short reward windows so the post→claim path is testable fast: EPOCH 1h, finalityDelay 0, challenge 0, claim 1d
  const rv = await D("RewardVault", await router.getAddress(), owner, owner, 3600, 0, 0, 86400, owner);
  await (await router.setRewardVault(await rv.getAddress())).wait();
  const floorFac = await D("FloorCoopFactory", WETH, V3FAC, owner);
  console.log("deployed. router=", await router.getAddress(), "floorFac=", await floorFac.getAddress());

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
    "function sell(address token, uint256 amountIn, uint256 minOutEth) returns (uint256)",
    "function withdrawDev(address token)", "function burnDev(address token)", "function devEscrow(address) view returns (uint256)",
    "function platformEscrow() view returns (uint256)", "function withdrawPlatform()",
    "function deferredEscrow(address) view returns (uint256)", "function floorEscrow(address) view returns (uint256)", "function rescueUngraduated(address token)",
    "function configOf(address) view returns ((address pool,address curve,address projectWallet,uint16 buyBps,uint16 sellBps,uint16 walletBps,uint16 floorBps,uint16 burnBps,bool set))",
    "function rewardVault() view returns (address)",
  ], await router.getAddress());
  console.log("router.rewardVault=", await routerC.rewardVault());
  const erc = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], token);

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

  // (A2) SELL half the bag (approve → router.sell), then exercise dev fee controls
  try {
    const bal = await erc.balanceOf(owner);
    const amt = bal / 2n;
    await (await erc.approve(await router.getAddress(), amt)).wait();
    const out = await routerC.sell.staticCall(token, amt, 0n);
    const src = await (await routerC.sell(token, amt, 0n)).wait();
    console.log("SELL OK → ethOut=", ethers.formatEther(out), "gas=", src.gasUsed.toString());
    console.log("devEscrow after sell=", ethers.formatEther(await routerC.devEscrow(token)), "ETH · platformEscrow=", ethers.formatEther(await routerC.platformEscrow()), "ETH");
    const wrc = await (await routerC.withdrawDev(token)).wait();
    console.log("withdrawDev OK gas=", wrc.gasUsed.toString());
  } catch (e) {
    console.log("SELL/DEVFEE FAILED:", e.shortMessage || e.message);
    if (e.data) console.log("  revert data:", e.data);
  }

  // (A3) another sell to re-accrue, then buy&burn with the escrow
  try {
    const bal = await erc.balanceOf(owner);
    const amt = bal / 4n;
    if (amt > 0n) {
      await (await erc.approve(await router.getAddress(), amt)).wait();
      await (await routerC.sell(token, amt, 0n)).wait();
      const esc = await routerC.devEscrow(token);
      console.log("devEscrow before burn=", ethers.formatEther(esc), "ETH");
      const brc2 = await (await routerC.burnDev(token)).wait();
      console.log("burnDev OK gas=", brc2.gasUsed.toString());
    }
  } catch (e) {
    console.log("BURNDEV FAILED:", e.shortMessage || e.message);
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

  // (C) FloorCoop LP: createCoop → warm the oracle → deposit → claim → withdraw
  try {
    let coop = await floorFac.coopOf(token);
    if (/^0x0+$/.test(coop)) { await (await floorFac.createCoop(token)).wait(); coop = await floorFac.coopOf(token); }
    const coopC = await ethers.getContractAt([
      "function deposit(uint256 lockDays, uint256 minSharesOut) payable returns (uint256)",
      "function withdraw(uint256 shareAmt, uint256 minWethOut, uint256 minTokenOut) returns (uint256,uint256)",
      "function claim()", "function compound()", "function shares(address) view returns (uint256)",
      "function pending(address) view returns (uint256 wethOwed, uint256 tokenOwed)",
      "function totalNav() view returns (uint256)", "function totalShares() view returns (uint256)",
    ], coop);
    // warm the oracle: two swaps ≥30s apart to write observations, then let the price hold long enough that the
    // TWAP window (300s) is entirely in the settled period → spot ≈ TWAP, so the deposit's Manipulated guard passes.
    await (await routerC.buy(token, 0n, { value: ethers.parseEther("0.05") })).wait();
    await ethers.provider.send("evm_increaseTime", [45]); await ethers.provider.send("evm_mine", []);
    await (await routerC.buy(token, 0n, { value: ethers.parseEther("0.05") })).wait();
    await ethers.provider.send("evm_increaseTime", [400]); await ethers.provider.send("evm_mine", []);
    const drc = await (await coopC.deposit(90, 0n, { value: ethers.parseEther("0.1") })).wait();
    const sh = await coopC.shares(owner);
    const navDep = await coopC.totalNav();
    console.log("FLOOR deposit OK gas=", drc.gasUsed.toString(), "shares=", sh.toString(), "nav=", ethers.formatEther(navDep));

    // now the real question: DOES an LP provider EARN fees when people trade? Generate real volume with BALANCED
    // round-trips (buy, then sell exactly what was bought) so price returns near start (fees accrue, TWAP stays put).
    for (let i = 0; i < 10; i++) {
      const b0 = await erc.balanceOf(owner);
      await (await routerC.buy(token, 0n, { value: ethers.parseEther("0.3") })).wait();
      const got = (await erc.balanceOf(owner)) - b0;
      await (await erc.approve(await router.getAddress(), got)).wait();
      await (await routerC.sell(token, got, 0n)).wait();
    }
    await ethers.provider.send("evm_increaseTime", [400]); await ethers.provider.send("evm_mine", []); // settle so TWAP ≈ spot
    try { await (await coopC.compound()).wait(); } catch (e) { console.log("compound:", e.shortMessage || e.message); }
    const pend = await coopC.pending(owner);
    const navVol = await coopC.totalNav();
    console.log("FLOOR EARNED → pending weth=", ethers.formatEther(pend[0]), "token=", ethers.formatUnits(pend[1], 18), "· nav", ethers.formatEther(navDep), "→", ethers.formatEther(navVol));

    const balB = await ethers.provider.getBalance(owner);
    const crc = await (await coopC.claim()).wait();
    const balA = await ethers.provider.getBalance(owner);
    console.log("FLOOR claim OK gas=", crc.gasUsed.toString(), "net ETH to staker (incl gas)=", ethers.formatEther(balA - balB));
    const wrc = await (await coopC.withdraw(sh, 0n, 0n)).wait();
    console.log("FLOOR withdraw OK gas=", wrc.gasUsed.toString(), "sharesAfter=", (await coopC.shares(owner)).toString());
  } catch (e) {
    console.log("FLOOR FAILED:", e.shortMessage || e.message);
    if (e.data) console.log("  revert data:", e.data);
  }

  // (D) RewardVault: accrue a leg → advance the epoch → poster posts a root → user claims
  try {
    const rvC = await ethers.getContractAt([
      "function currentEpoch() view returns (uint256)", "function EPOCH() view returns (uint256)",
      "function pot(address,uint256) view returns (uint128 traderPot, uint128 holderPot)",
      "function postRoot(uint256 epoch, bytes32 root, bytes32 algoHash, string uri)",
      "function claim(uint256 epoch, address coin, uint8 side, uint256 amount, bytes32[] proof)",
    ], await rv.getAddress());
    const E = Number(await rvC.currentEpoch());
    await (await routerC.buy(token, 0n, { value: ethers.parseEther("0.2") })).wait(); // 0.25% → traderPot for epoch E
    const pot = await rvC.pot(token, E);
    console.log("rewards epoch E=", E, "traderPot=", ethers.formatEther(pot.traderPot));
    const amount = pot.traderPot;
    const EPOCH = Number(await rvC.EPOCH());
    await ethers.provider.send("evm_setNextBlockTimestamp", [(E + 1) * EPOCH + 5]); await ethers.provider.send("evm_mine", []);
    // single-claimant → the whole pot is one leaf; OZ StandardMerkleTree root of one leaf IS the leaf, proof []
    const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint8", "address", "uint256"], [E, token, 0, owner, amount]));
    const leaf = ethers.keccak256(inner);
    await (await rvC.postRoot(E, leaf, ethers.keccak256(ethers.toUtf8Bytes("RobinLabs-Rewards-v1")), "")).wait();
    const crc = await (await rvC.claim(E, token, 0, amount, [])).wait();
    console.log("REWARD post+claim OK gas=", crc.gasUsed.toString(), "claimed=", ethers.formatEther(amount), "ETH");
  } catch (e) {
    console.log("REWARDS FAILED:", e.shortMessage || e.message);
    if (e.data) console.log("  revert data:", e.data);
  }

  // (E) platform fee withdrawal (permissionless; funds go to owner)
  try {
    const pe = await routerC.platformEscrow();
    const prc = await (await routerC.withdrawPlatform()).wait();
    console.log("PLATFORM withdrawPlatform OK gas=", prc.gasUsed.toString(), "escrow", ethers.formatEther(pe), "→", ethers.formatEther(await routerC.platformEscrow()));
  } catch (e) { console.log("PLATFORM FAILED:", e.shortMessage || e.message); }

  // (F) FloorCoopFactory ownership handoff (the new one-step transferOwnership the deploy uses)
  try {
    const signers = await ethers.getSigners();
    const before = await floorFac.owner();
    await (await floorFac.transferOwnership(signers[1].address)).wait();
    const after = await floorFac.owner();
    console.log("FLOOR OWNERSHIP:", before, "->", after, after.toLowerCase() === signers[1].address.toLowerCase() ? "OK" : "MISMATCH");
  } catch (e) { console.log("OWNERSHIP FAILED:", e.shortMessage || e.message); }

  // (G) rescueUngraduated — recover stuck deferred/floor escrow for a coin that NEVER graduates (the audit fix)
  try {
    const tax2 = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: owner };
    await (await factory.launch({ name: "Never", symbol: "NEVER", dev: owner, tax: tax2 }, { value: 0n })).wait();
    const tok2 = await factory.allTokens(1);
    const t2 = await ethers.getContractAt(["function windowEndsAt() view returns (uint256)"], tok2);
    const we = Number(await t2.windowEndsAt());
    await ethers.provider.send("evm_setNextBlockTimestamp", [we + 5]); await ethers.provider.send("evm_mine", []);
    await (await routerC.buy(tok2, 0n, { value: ethers.parseEther("0.5") })).wait(); // accrues the deferred 0.1%
    const def = await routerC.deferredEscrow(tok2);
    const peBefore = await routerC.platformEscrow();
    const rrc = await (await routerC.rescueUngraduated(tok2)).wait();
    const peAfter = await routerC.platformEscrow();
    const defAfter = await routerC.deferredEscrow(tok2);
    const ok = def > 0n && peAfter - peBefore === def && defAfter === 0n;
    console.log("RESCUE ungraduated:", ok ? "OK" : "MISMATCH", "· recovered", ethers.formatEther(def), "ETH to platform · gas=", rrc.gasUsed.toString());
    // and it must REFUSE a graduated coin (token was graduated earlier in this run)
    try { await routerC.rescueUngraduated.staticCall(token); console.log("  ✗ rescue on a GRADUATED coin did NOT revert (bad)"); }
    catch (e) { console.log("  ✓ rescue correctly refuses a graduated coin:", (e.shortMessage || e.message).includes("graduated") ? "graduated" : (e.shortMessage || e.message)); }
  } catch (e) { console.log("RESCUE FAILED:", e.shortMessage || e.message); if (e.data) console.log("  data:", e.data); }
}
main().catch((e) => { console.error(e); process.exit(1); });
