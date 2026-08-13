const { ethers } = require("hardhat");
const { expect } = require("chai");
const solc = require("solc");

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const TOKEN = 0;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));

function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

// A completely generic one-transaction multicall. Nothing special: it just proves that the
// buy -> seedAmbush -> sell sequence is composable inside ONE transaction (i.e. unfront-runnable).
const RESCUER_SRC = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface IERC20x { function balanceOf(address) external view returns (uint256); function approve(address,uint256) external returns (bool); }
interface IAmb { function seedAmbush() external returns (uint128); }
contract Rescuer {
    struct PoolKey { address c0; address c1; uint24 fee; int24 ts; address hooks; }
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 limit; }
    struct Settings { bool takeClaims; bool settleUsingBurn; }
    string constant SIG = "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)";

    /// ONE transaction: buy the token (pushing the tick back below the band), seed the ambush band,
    /// then sell the whole bag straight back. No privileged role anywhere in this path.
    function rescue(address swapper, PoolKey calldata key, uint160 buyLimit, uint160 sellLimit, uint256 buyEth, address amb)
        external payable
    {
        (bool ok, bytes memory r) = swapper.call{value: buyEth}(
            abi.encodeWithSignature(SIG, key, SwapParams(true, -int256(buyEth), buyLimit), Settings(false, false), bytes(""))
        );
        if (!ok) { assembly { revert(add(r, 32), mload(r)) } }

        IAmb(amb).seedAmbush();

        uint256 bal = IERC20x(key.c1).balanceOf(address(this));
        IERC20x(key.c1).approve(swapper, type(uint256).max);
        (ok, r) = swapper.call(
            abi.encodeWithSignature(SIG, key, SwapParams(false, -int256(bal), sellLimit), Settings(false, false), bytes(""))
        );
        if (!ok) { assembly { revert(add(r, 32), mload(r)) } }
    }
    receive() external payable {}
}`;

function compileRescuer() {
  const input = {
    language: "Solidity",
    sources: { "R.sol": { content: RESCUER_SRC } },
    settings: {
      optimizer: { enabled: true, runs: 1 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors && out.errors.some((e) => e.severity === "error")) throw new Error(JSON.stringify(out.errors));
  const c = out.contracts["R.sol"].Rescuer;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

describe("SCRATCH — is the ambush seed really stranded?", () => {
  const START = 6000, GRAD = 3000, SPACING = 60, FEE = 3000;
  const CURVE_SUPPLY = 1000n * 10n ** 18n;
  const RESERVE = 1000n * 10n ** 18n;
  let owner, platform, creator, trader, griefer;
  let pm, stateView, th, reg, permit2, posm, lockVault, mockFactory, tok, sw, ds, floor, ambush, curve, key, poolId, curveAddr;

  before(async () => {
    [owner, platform, creator, trader, griefer] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    th = await (await ethers.getContractFactory("TickHelper")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
    lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
    mockFactory = await (await ethers.getContractFactory("MockCurveFactory")).deploy();
    await mockFactory.setLockVault(await lockVault.getAddress());
    await lockVault.setFactory(await mockFactory.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());

    const tokAddr = await tok.getAddress();
    key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: SPACING, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, await th.sqrt(START));

    curve = await (await ethers.getContractFactory("RobinCurveV4")).deploy(
      await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
      await lockVault.getAddress(), await mockFactory.getAddress(), await reg.getAddress(),
      ZERO, tokAddr, FEE, SPACING, ZERO, START, GRAD, 2000, 1000, 1000, 500, creator.address
    );
    curveAddr = await curve.getAddress();
    await tok.connect(owner).transfer(curveAddr, CURVE_SUPPLY);
    await mockFactory.seedCurve(curveAddr);
    await tok.connect(owner).transfer(curveAddr, RESERVE);

    ds = await (await ethers.getContractFactory("DualStaking")).deploy(tokAddr, ZERO, owner.address, 0, ZERO, ethers.ZeroHash, TOKEN);
    await ds.setRewarder(curveAddr, true);
    await ds.listReward(TOKEN, tokAddr, 7 * 86400);
    await curve.connect(platform).setStaking(await ds.getAddress());

    floor = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), platform.address,
      ZERO, tokAddr, FEE, SPACING, ZERO, GRAD, 10
    );
    await curve.connect(platform).setFloor(await floor.getAddress());

    // the two-sided ambush band, anchored on-chain to curve.gradTick() == 3000, gap 0, width 10
    ambush = await (await ethers.getContractFactory("RobinAmbushVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), await floor.getAddress(), ZERO,
      curveAddr, ZERO, tokAddr, FEE, SPACING, ZERO, 0, 10
    );
    await curve.connect(platform).setAmbush(await ambush.getAddress());
  });

  it("reproduces the finding: graduate funds but does not seed; a back-run sell makes seedAmbush park", async () => {
    expect(await ambush.ambushTickLower()).to.equal(3060n);
    expect(await ambush.ambushTickUpper()).to.equal(3660n);

    // buy the curve out
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -E(6000), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(6000) }
    );
    expect(await curve.ready()).to.equal(true);
    await curve.graduate();

    const aAddr = await ambush.getAddress();
    const seed = await ethers.provider.getBalance(aAddr);
    console.log("    tick right after graduate()      :", (await stateView.getSlot0(poolId))[1].toString());
    console.log("    ambush vault ETH after graduate():", ethers.formatEther(seed));
    console.log("    ambushLiquidity after graduate() :", (await ambush.ambushLiquidity()).toString());
    expect(seed).to.be.gt(0n);
    expect(await ambush.ambushLiquidity()).to.equal(0n);
    expect((await stateView.getSlot0(poolId))[1]).to.equal(BigInt(GRAD));

    // griefer back-runs with a small sell
    await tok.connect(trader).transfer(griefer.address, E(6));
    await tok.connect(griefer).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(griefer).swap(
      key, { zeroForOne: false, amountSpecified: -E(6), sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x"
    );
    const tickAfterDump = (await stateView.getSlot0(poolId))[1];
    console.log("    tick after the 6-token back-run  :", tickAfterDump.toString());
    expect(tickAfterDump).to.be.gte(3060n);

    await expect(ambush.seedAmbush()).to.emit(ambush, "AmbushParked");
    expect(await ambush.ambushLiquidity()).to.equal(0n);
    expect(await ethers.provider.getBalance(aAddr)).to.equal(seed); // still sitting there
  });

  it("REFUTATION: any actor un-parks it in ONE atomic transaction (buy -> seedAmbush -> sell back)", async () => {
    const { abi: rAbi, bytecode } = compileRescuer();
    const RF = new ethers.ContractFactory(rAbi, bytecode, owner);
    const rescuer = await RF.deploy();
    const rAddr = await rescuer.getAddress();

    const aAddr = await ambush.getAddress();
    const swAddr = await sw.getAddress();
    const tokAddr = await tok.getAddress();
    const seedBefore = await ethers.provider.getBalance(aAddr);

    // fund the rescuer with working capital for the round trip
    await owner.sendTransaction({ to: rAddr, value: E(300) });
    const capital = await ethers.provider.getBalance(rAddr);

    const k = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
    // stop the buy exactly at tick 3000 (below ambushTickLower = 3060) — a bounded, partial-fill buy
    const limitBuy = await th.sqrt(3000);

    // ONE transaction: buy (tick 3181 -> 3000), seed the band, sell the whole bag back.
    await rescuer.rescue(swAddr, k, limitBuy, MAX_SQRT_LIMIT, E(200), aAddr);

    const L = await ambush.ambushLiquidity();
    const leftInVault = await ethers.provider.getBalance(aAddr);
    // dump whatever token the rescuer still holds so the cost accounting is ETH-only
    const dust = await tok.balanceOf(rAddr);
    const capitalAfter = await ethers.provider.getBalance(rAddr);

    console.log("    tick after the atomic rescue     :", (await stateView.getSlot0(poolId))[1].toString());
    console.log("    ambushLiquidity after rescue     :", L.toString());
    console.log("    ETH left stranded in the vault   :", ethers.formatEther(leftInVault));
    console.log("    seed that got deployed           :", ethers.formatEther(seedBefore - leftInVault));
    console.log("    rescuer ETH in / out             :", ethers.formatEther(capital), "->", ethers.formatEther(capitalAfter));
    console.log("    rescuer NET ETH cost             :", ethers.formatEther(capital - capitalAfter));
    console.log("    rescuer leftover token dust      :", ethers.formatEther(dust));

    expect(L).to.be.gt(0n);          // the band IS armed
    expect(leftInVault).to.equal(0n); // every wei of the seed went into the band
  });
});
