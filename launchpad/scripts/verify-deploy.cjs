/* eslint-disable no-console */
// Validate deploy.js's ownership flow when the DEPLOYER is different from OWNER (the real mainnet case).
// Deploys the full stack locally exactly as deploy.js does, then asserts every contract ends up owned by OWNER
// (router pending until accept), and that the deployer could wire the router.  npx hardhat run scripts/verify-deploy.cjs
const { ethers } = require("hardhat");
const V3 = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

async function main() {
  const [deployer, ownerAcct] = await ethers.getSigners();
  const owner = ownerAcct.address; // DIFFERENT from deployer — the real case
  const D = async (n, ...a) => { const c = await (await ethers.getContractFactory(n)).deploy(...a); await c.waitForDeployment(); return c; };
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  let ok = true; const assert = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) ok = false; };

  const weth = await D("MockWETH9");
  const v3 = await new ethers.ContractFactory(V3.abi, V3.bytecode, deployer).deploy(); await v3.waitForDeployment();
  const WETH = await weth.getAddress(), V3FAC = await v3.getAddress();
  const ltd = await D("LaunchTokenDeployer"), cpd = await D("CurvePoolDeployer"), bd = await D("BondDeployer");

  // mirror deploy.js exactly:
  const router = await D("PadRouter", WETH, deployer.address);         // owned by deployer so it can self-wire
  const factory = await D("CurvePadFactory", WETH, V3FAC, owner, owner, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207400, 38000, 27000);
  await (await router.setFactory(await factory.getAddress())).wait();  // deployer wires — must succeed
  const rv = await D("RewardVault", await router.getAddress(), owner, owner, 3600, 0, 0, 86400, owner);
  await (await router.setRewardVault(await rv.getAddress())).wait();
  await (await router.transferOwnership(owner)).wait();                // 2-step → pending
  const floorFac = await D("FloorCoopFactory", WETH, V3FAC, owner);
  await (await floorFac.transferOwnership(owner)).wait();              // 1-step → immediate
  const splitter = await D("PlatformFeeSplitter", owner, owner);

  const R = await ethers.getContractAt(["function owner() view returns (address)", "function pendingOwner() view returns (address)",
    "function isFactory(address) view returns (bool)", "function rewardVault() view returns (address)", "function acceptOwnership()"], await router.getAddress());
  assert("router wired the factory (deployer could call setFactory)", await R.isFactory(await factory.getAddress()));
  assert("router.rewardVault set", eq(await R.rewardVault(), await rv.getAddress()));
  assert("router owner is still deployer (pre-accept)", eq(await R.owner(), deployer.address));
  assert("router pendingOwner is OWNER", eq(await R.pendingOwner(), owner));
  const oview = (a) => ethers.getContractAt(["function owner() view returns (address)"], a);
  assert("factory owned by OWNER", eq(await (await oview(await factory.getAddress())).owner(), owner));
  assert("rewardVault owned by OWNER", eq(await (await oview(await rv.getAddress())).owner(), owner));
  assert("floorCoopFactory owned by OWNER", eq(await floorFac.owner(), owner));
  assert("splitter owned by OWNER", eq(await (await oview(await splitter.getAddress())).owner(), owner));

  // OWNER accepts the router → now owns everything
  await (await R.connect(ownerAcct).acceptOwnership()).wait();
  assert("after OWNER accepts, router owned by OWNER", eq(await R.owner(), owner));

  console.log(ok ? "\n✅ deploy ownership flow correct (deployer != owner)" : "\n❌ ownership flow BROKEN");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
