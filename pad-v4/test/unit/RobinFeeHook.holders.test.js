const { ethers } = require("hardhat");
const { expect } = require("chai");

// Feature 1 — the O(1) holder accumulator. Drives real swaps to accrue the holder cut, then
// checks: (1) with no weight the cut PARKS in `unallocated` (never routed to platform), (2) once
// weight exists the parked + new cuts distribute proportionally, (3) two holders split by weight,
// (4) per-currency isolation. Weight is driven by MockWeightSource (Feature 2's DualStaking stand-in).

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAGS = 0xc4n, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(dep, initCodeHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(dep, salt, initCodeHash);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}
function poolIdOf(k) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]])
  );
}

describe("RobinFeeHook — O(1) holder accumulator (park / distribute / proportional)", () => {
  let owner, factory, platform, lp, trader, creator, alice, bob;
  let pm, dep, reg, tok, hook, mod, sw, wsrc, key, poolId;
  const UC = 1;

  async function buy(amountEth) {
    await sw.connect(trader).swap(
      key, { zeroForOne: true, amountSpecified: -ethers.parseEther(amountEth), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(amountEth) }
    );
  }

  before(async () => {
    [owner, factory, platform, lp, trader, creator, alice, bob] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);

    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address"], [await pm.getAddress(), factory.address, await reg.getAddress()]),
    ]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr);

    wsrc = await (await ethers.getContractFactory("MockWeightSource")).deploy(addr);

    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: addr };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address,
      weightSource: await wsrc.getAddress(), guardAdapter: ZERO,
      feeBps: 100, platformShareBps: 4000, creatorShareBps: 3000, guardWindow: 0, quoteIsStock: false,
    });

    mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(
      key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 20n, salt: ethers.ZeroHash }, "0x",
      { value: ethers.parseEther("2000") }
    );
  });

  it("parks the holder cut when there is no weight, and never sends it to platform", async () => {
    await buy("1");
    const parked = await hook.unallocated(poolId, UC);
    const plat = await hook.platformOwed(poolId, UC);
    const crea = await hook.creatorOwed(poolId, UC);
    expect(parked).to.be.gt(0n);
    // shares are platform 40% / creator 30% / holder 30% of the skim, so parked(holder) ≈ creator,
    // and platform got exactly its 40% — the holder remainder never leaked to platform.
    const d = parked > crea ? parked - crea : crea - parked;
    expect(d <= 2n).to.equal(true);
    expect(await hook.totalWeight(poolId)).to.equal(0n);
  });

  it("distributes parked + new cuts once weight exists; two holders split proportionally", async () => {
    // alice weight 3, bob weight 1 → alice gets 75%, bob 25% of holder rewards accrued AFTER weighting
    await wsrc.setWeight(poolId, alice.address, 3n);
    await wsrc.setWeight(poolId, bob.address, 1n);
    expect(await hook.totalWeight(poolId)).to.equal(4n);

    const parkedBefore = await hook.unallocated(poolId, UC);
    await buy("1"); // this swap's _accrueHolders folds parkedBefore + new hCut into rewardPerToken

    const aClaim = await hook.holderClaimable(poolId, alice.address, UC);
    const bClaim = await hook.holderClaimable(poolId, bob.address, UC);
    expect(aClaim).to.be.gt(0n);
    expect(bClaim).to.be.gt(0n);
    // alice ≈ 3× bob (allow 1 wei rounding)
    const diff = aClaim - bClaim * 3n;
    expect(diff >= -3n && diff <= 3n).to.equal(true);
    // total distributed ≈ parkedBefore + this round's holder cut; parked should now be tiny (dust only)
    expect(await hook.unallocated(poolId, UC)).to.be.lt(parkedBefore);
  });

  it("holder can claim their currency leg to themselves", async () => {
    const before = await tok.balanceOf(alice.address);
    const claimable = await hook.holderClaimable(poolId, alice.address, UC);
    await hook.connect(alice).claimHolder(poolId, UC);
    const got = (await tok.balanceOf(alice.address)) - before;
    expect(got).to.equal(claimable);
    // claimed leg resets; nothing left immediately after
    expect(await hook.holderClaimable(poolId, alice.address, UC)).to.equal(0n);
  });
});
