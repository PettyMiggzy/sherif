const { ethers, network } = require("hardhat");
const { expect } = require("chai");

// ─────────────────────────────────────────────────────────────────────────────
// A3 GATE — the fork variant. Same assertions as test/unit/RobinFeeHook.skim, but
// driven against the EXACT live PoolManager (0x8366) and its real on-chain state
// (protocol-fee config, etc.), not a fresh local deploy. Run:
//   FORK_RPC=<robinhood rpc> npx hardhat test test/fork/A3.skim.fork.test.js
// Skipped automatically when FORK_RPC is unset.
// ─────────────────────────────────────────────────────────────────────────────

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAGS = 0xc4n;
const MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(deployerAddr, initCodeHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, salt, initCodeHash);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}
function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("A3 fork — exact-input skim closes clean against live 0x8366", function () {
  before(function () {
    if (!process.env.FORK_RPC) this.skip();
  });

  it("skims exact-input, no residual delta, split exact", async () => {
    const [owner, factory, platform, lp, trader, creator] = await ethers.getSigners();
    const pm = await ethers.getContractAt("PoolManager", POOL_MANAGER);

    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);

    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address", "address"], [POOL_MANAGER, factory.address, await reg.getAddress(), await tok.getAddress()]),
    ]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    const hook = HookF.attach(addr);

    const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: addr };
    const poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address,
      floorRecipient: ZERO, guardAdapter: ZERO, buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000,
      guardWindow: 0, quoteIsStock: false,
    });

    const mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(POOL_MANAGER);
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(POOL_MANAGER);
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 20n, salt: ethers.ZeroHash }, "0x",
      { value: ethers.parseEther("2000") }
    );

    const hookAddr = await hook.getAddress();
    const hb = await tok.balanceOf(hookAddr);
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther("1"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("1") }
    );
    const skim = (await tok.balanceOf(hookAddr)) - hb;
    expect(skim).to.be.gt(0n);
    // buy → the whole token-leg skim books to platform
    expect(await hook.platformOwed(poolId, 1)).to.equal(skim);
  });
});
