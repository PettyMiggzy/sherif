const { ethers } = require("hardhat");

// CALIBRATION (not an assertion suite): find the curveSupply that graduates at a tiny, faucet-reachable raise,
// using the REAL deploy geometry (startTickMag=201600, curveWidth=25800, ts=60). Prints the raise per candidate.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const START = 201600, WIDTH = 25800, GRAD = START - WIDTH, TS = 60, FEE = 10000;
function poolIdOf(k) {
  return ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));
}

describe("CALIBRATION — tiny testnet graduation raise", () => {
  it("prints the raise for several curveSupply sizes (deploy geometry)", async () => {
    const [owner, platform, creator, trader] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const th = await (await ethers.getContractFactory("TickHelper")).deploy();

    for (const curveSupply of [1000n, 100n, 25n].map((x) => x * 10n ** 18n)) {
      const reserve = curveSupply; // >= invariant
      const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
      const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
      const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
      const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
      const mf = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
      await mf.setLockVault(await lockVault.getAddress());
      await lockVault.setFactory(await mf.getAddress());
      const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
      const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
      const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: ZERO };
      await pm.initialize(key, await th.sqrt(START));

      const curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
        await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
        await lockVault.getAddress(), await mf.getAddress(), await reg.getAddress(),
        ZERO, await tok.getAddress(), FEE, TS, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address
      );
      const curveAddr = await curve.getAddress();
      await tok.connect(owner).transfer(curveAddr, curveSupply);
      await mf.seedCurve(curveAddr);
      await tok.connect(owner).transfer(curveAddr, reserve);

      // buy out with a generous ceiling; measure ETH actually consumed to reach ready()
      const before = await ethers.provider.getBalance(trader.address);
      const rc = await (await sw.connect(trader).swap(
        key, { zeroForOne: true, amountSpecified: -ethers.parseEther("100"), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
        { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther("100") }
      )).wait();
      const spent = before - (await ethers.provider.getBalance(trader.address)) - rc.gasUsed * rc.gasPrice;
      const ready = await curve.ready();
      console.log(`      curveSupply=${ethers.formatEther(curveSupply)}  →  raise ≈ ${ethers.formatEther(spent)} ETH   (ready=${ready})`);
    }
  });
});
