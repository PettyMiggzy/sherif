const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinFeeHook — on-chain referral revenue-share. A referrer passed in the swap hookData on a BUY earns a slice
// (referralShareBps) of the PLATFORM's buy-tax cut — carved from the platform, never the buffer, never the trader.
// The reward is the MONEY SIDE (ETH — the buy tax is fee-on-input, denominated in currency0); the referrer pulls
// it with claimReferral(address(0)), which sweeps every ETH pad they referred in one call.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAGS = 0xccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(deployerAddr, initCodeHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, salt, initCodeHash);
    if ((BigInt(addr) & MASK) === FLAGS) return { salt, addr };
  }
}
function poolIdOf(key) {
  return ethers.keccak256(
    abi.encode(["tuple(address,address,uint24,int24,address)"], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]])
  );
}

describe("RobinFeeHook — on-chain referral revenue-share (ETH-denominated buy tax)", () => {
  const FEE = 3000, TS = 60;
  const BUY_BPS = 100n;      // 1% buy tax (money side)
  const BUFFER_SHARE_BPS = 2000n; // 20% of the buy tax → curve buffer
  const REFERRAL_SHARE_BPS = 2500n; // 25% of the PLATFORM cut → referrer

  let owner, factory, platform, lp, trader, creator, floor, referrer;
  let pm, dep, reg, tok, hook, mod, sw, key, poolId, tokAddr;

  const buy = (amt, hookData) => sw.connect(trader).swap(
    key, { zeroForOne: true, amountSpecified: -ethers.parseEther(amt), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false }, hookData, { value: ethers.parseEther(amt) }
  );

  before(async () => {
    [owner, factory, platform, lp, trader, creator, floor, referrer] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    tokAddr = await tok.getAddress();

    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([
      HookF.bytecode,
      abi.encode(["address", "address", "address", "address"], [await pm.getAddress(), factory.address, await reg.getAddress(), tokAddr]),
    ]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    hook = HookF.attach(addr);

    key = { currency0: ZERO, currency1: tokAddr, fee: FEE, tickSpacing: TS, hooks: addr };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: tokAddr, creator: creator.address, floorRecipient: floor.address, guardAdapter: ZERO,
      buyTaxBps: BUY_BPS, sellTaxBps: 100, sellFloorShareBps: 2000, buyBufferShareBps: BUFFER_SHARE_BPS,
      referralShareBps: REFERRAL_SHARE_BPS, guardWindow: 0, quoteIsStock: false,
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

  it("a buy WITH a referrer in hookData carves the referral from the platform cut (not the buffer, not the trader)", async () => {
    const hookAddr = await hook.getAddress();
    const hookEthBefore = await ethers.provider.getBalance(hookAddr);
    const spend = ethers.parseEther("1");

    const hookData = abi.encode(["address"], [referrer.address]);
    await buy("1", hookData);

    const skim = (await ethers.provider.getBalance(hookAddr)) - hookEthBefore; // total buy tax (ETH, fee-on-input)
    expect(skim).to.equal((spend * BUY_BPS) / 10000n); // trader paid exactly 1% of the ETH they spent — no extra cost

    const bufferCut = (skim * BUFFER_SHARE_BPS) / 10000n;
    const platformCut = skim - bufferCut;                 // platform's slice before the referral carve
    const referralCut = (platformCut * REFERRAL_SHARE_BPS) / 10000n;

    expect(await hook.referralOwed(referrer.address, ZERO)).to.equal(referralCut); // ETH-keyed (address(0))
    expect(await hook.platformOwed(poolId, 0)).to.equal(platformCut - referralCut); // money side; platform keeps the rest
    expect(await hook.bufferOwed(poolId)).to.equal(bufferCut); // buffer untouched by referral
    expect(referralCut).to.be.gt(0n);
  });

  it("a buy with NO referrer (empty hookData) sends the whole platform cut to the platform", async () => {
    const platBefore = await hook.platformOwed(poolId, 0);
    const refBefore = await hook.referralOwed(referrer.address, ZERO);
    const hookAddr = await hook.getAddress();
    const hookEth0 = await ethers.provider.getBalance(hookAddr);

    await buy("1", "0x"); // no referrer

    const skim = (await ethers.provider.getBalance(hookAddr)) - hookEth0;
    const platformCut = skim - (skim * BUFFER_SHARE_BPS) / 10000n;
    expect((await hook.platformOwed(poolId, 0)) - platBefore).to.equal(platformCut); // full platform cut, no referral
    expect(await hook.referralOwed(referrer.address, ZERO)).to.equal(refBefore); // referrer unchanged
  });

  it("the referrer claims their accrued ETH; the book zeroes and a re-claim reverts", async () => {
    const owed = await hook.referralOwed(referrer.address, ZERO);
    expect(owed).to.be.gt(0n);
    const before = await ethers.provider.getBalance(referrer.address);
    const rc = await (await hook.connect(referrer).claimReferral(ZERO)).wait(); // permissionless; pays msg.sender only
    const gas = rc.gasUsed * rc.gasPrice;
    expect((await ethers.provider.getBalance(referrer.address)) - before).to.equal(owed - gas);
    expect(await hook.referralOwed(referrer.address, ZERO)).to.equal(0n);
    await expect(hook.connect(referrer).claimReferral(ZERO)).to.be.revertedWithCustomError(hook, "NothingToClaim");
  });

  it("malformed hookData never bricks a buy (defensive decode)", async () => {
    // 5 bytes of junk (< 32) → no referrer, buy still succeeds and books the full platform cut
    await expect(buy("0.1", "0x1234567890")).to.not.be.reverted;
  });
});
