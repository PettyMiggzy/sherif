const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineTokenSalt, mineHookSalt, hookInitCode, CA_SUFFIX, CA_SUFFIX_MASK } = require("../../scripts/mine");

// Brand suffix: every pad token launched through the Robin tooling lands on a CREATE2 address ending in
// `1ab5`, so a Robin coin is recognizable from its contract address alone. This pins the miner: the suffix
// actually lands, distinct pads never collide on a salt, and mining the token does not disturb the hook's
// flag mining (the hook address must still carry 0x00CC in its low 14 bits, or the PoolManager rejects it).
describe("vanity CA — pad tokens end in 1ab5", () => {
  let deployer, deployerAddr, TokenF, HookF, abi;

  const tokenInitFor = (name, symbol, supply, factory) =>
    ethers.concat([
      TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"], [name, symbol, 18, supply, factory]),
    ]);

  before(async () => {
    abi = ethers.AbiCoder.defaultAbiCoder();
    TokenF = await ethers.getContractFactory("PadToken");
    HookF = await ethers.getContractFactory("RobinFeeHook");
    deployer = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    deployerAddr = await deployer.getAddress();
  });

  it("mines a salt whose CREATE2 address ends in 1ab5", async () => {
    const init = tokenInitFor("Robin Coin", "ROBIN", 10n ** 24n, deployerAddr);
    const { salt, addr } = mineTokenSalt(deployerAddr, init, ethers.id("ROBIN"));
    expect(addr.toLowerCase().endsWith("1ab5")).to.equal(true);
    expect(BigInt(addr) & CA_SUFFIX_MASK).to.equal(CA_SUFFIX);
    // the prediction must match what the deployer actually produces on-chain
    expect(await deployer.addressOf(salt, ethers.keccak256(init))).to.equal(addr);
  });

  it("the mined address is what actually gets deployed on-chain", async () => {
    const init = tokenInitFor("Deploy Me", "DEPLOY", 10n ** 24n, deployerAddr);
    const { salt, addr } = mineTokenSalt(deployerAddr, init, ethers.id("DEPLOY"));
    await (await deployer.deploy(salt, init)).wait();
    expect((await ethers.provider.getCode(addr)).length).to.be.greaterThan(2); // real code at the vanity CA
    expect(addr.toLowerCase().endsWith("1ab5")).to.equal(true);
    expect(await (await ethers.getContractAt("PadToken", addr)).symbol()).to.equal("DEPLOY");
  });

  it("two pads sharing identical token params still mine DISTINCT addresses (no CREATE2 adopt-collision)", async () => {
    // identical name/symbol/supply/factory ⇒ identical initCodeHash; only the per-pad baseSalt differs.
    const init = tokenInitFor("Same Name", "SAME", 10n ** 24n, deployerAddr);
    const a = mineTokenSalt(deployerAddr, init, ethers.id("pad-A"));
    const b = mineTokenSalt(deployerAddr, init, ethers.id("pad-B"));
    expect(a.salt).to.not.equal(b.salt);
    expect(a.addr).to.not.equal(b.addr);
    for (const r of [a, b]) expect(r.addr.toLowerCase().endsWith("1ab5")).to.equal(true);
  });

  it("token mining does NOT disturb the hook's 0x00CC flag mining", async () => {
    const init = tokenInitFor("Both Mines", "BOTH", 10n ** 24n, deployerAddr);
    const { addr: predictedToken } = mineTokenSalt(deployerAddr, init, ethers.id("BOTH"));
    // the hook init-code embeds the mined token, exactly as launch.js orders it
    const hookInit = hookInitCode(HookF.bytecode, deployerAddr, deployerAddr, deployerAddr, predictedToken);
    const { addr: hookAddr } = mineHookSalt(deployerAddr, hookInit);
    expect(BigInt(hookAddr) & 0x3fffn).to.equal(0xccn); // hook flags survive
    expect(predictedToken.toLowerCase().endsWith("1ab5")).to.equal(true); // token suffix survives
  });
});
