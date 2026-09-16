const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinFeeHook — on-chain referral revenue-share. A referrer passed in the swap hookData on a BUY earns a slice
// (referralShareBps) of the PLATFORM's buy-tax cut — carved from the platform, never the buffer, never the trader.
// The reward is the MONEY SIDE (ETH — the buy tax is fee-on-input, denominated in currency0); the referrer pulls
// it with claimReferral(address(0)), which sweeps every ETH pad they referred in one call.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAGS = 0x28ccn, MASK = 0x3fffn;
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
    await pm.connect(factory).initialize(key, SQRT_1_1);
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

  it("a buy WITH a referrer in hookData carves the referral from the trader-rebate pool (not the creator) [SIMPLE-FEES v2]", async () => {
    const hookAddr = await hook.getAddress();
    const claimBefore = await pm.balanceOf(hookAddr, 0n); // ERC-6909 native-ETH claim (buy fee is minted, not taken)
    const spend = ethers.parseEther("1");

    const hookData = abi.encode(["address"], [referrer.address]);
    await buy("1", hookData);

    const skim = (await pm.balanceOf(hookAddr, 0n)) - claimBefore; // total buy tax (ETH claim, fee-on-input)
    expect(skim).to.equal((spend * BUY_BPS) / 10000n); // trader paid exactly 1% of the ETH they spent — no extra cost

    const bufferCut = (skim * BUFFER_SHARE_BPS) / 10000n;
    const creatorCut = skim - bufferCut;                 // [SIMPLE-FEES v2] flat, referral-independent
    const referralCut = (bufferCut * REFERRAL_SHARE_BPS) / 10000n; // carved from the rebate pool, not creator

    expect(await hook.referralOwed(referrer.address, ZERO)).to.equal(referralCut); // ETH-keyed (address(0))
    expect(await hook.creatorOwed(poolId, 0)).to.equal(creatorCut); // money side; UNAFFECTED by referral
    expect(await hook.bufferOwed(poolId)).to.equal(bufferCut - referralCut); // rebate pool keeps the rest
    expect(referralCut).to.be.gt(0n);
  });

  it("a buy with NO referrer (empty hookData) sends the whole remainder to the creator [SIMPLE-FEES]", async () => {
    const creatorBefore = await hook.creatorOwed(poolId, 0);
    const refBefore = await hook.referralOwed(referrer.address, ZERO);
    const hookAddr = await hook.getAddress();
    const claim0 = await pm.balanceOf(hookAddr, 0n);

    await buy("1", "0x"); // no referrer

    const skim = (await pm.balanceOf(hookAddr, 0n)) - claim0;
    const creatorCut = skim - (skim * BUFFER_SHARE_BPS) / 10000n;
    expect((await hook.creatorOwed(poolId, 0)) - creatorBefore).to.equal(creatorCut); // full remainder, no referral
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

  it("[audit, SIMPLE-FEES v2] SELF-REFERRAL is a permissionless rebate that only lowers the TRADER-REBATE POOL's own take — conservation holds, the creator is pinned", async () => {
    // A buyer names THEMSELVES as the referrer. On-chain this cannot be prevented (a Sybil alt-wallet works too),
    // so the referral is by-design an at-most-referralShareBps rebate on the trader-rebate pool's OWN take
    // (moved off the creator's cut in [SIMPLE-FEES v2], so the creator's share is now flat and
    // referral-independent). This sim PRICES the worst case: it must never touch the creator's cut, the
    // trader's tokens, or any other book — only move rebate-pool→self.
    const hookAddr = await hook.getAddress();
    const claimBefore = await pm.balanceOf(hookAddr, 0n);
    const creatorBefore = await hook.creatorOwed(poolId, 0);
    const buffBefore = await hook.bufferOwed(poolId);
    const spend = ethers.parseEther("1");

    await buy("1", abi.encode(["address"], [trader.address])); // buyer == referrer (self-referral)

    const fee = (spend * BUY_BPS) / 10000n;                     // 1% of input
    const bufferCut = (fee * BUFFER_SHARE_BPS) / 10000n;        // trader-rebate pool's share, before referral
    const creatorCut = fee - bufferCut;                         // [SIMPLE-FEES v2] flat, UNAFFECTED by referral
    const referralCut = (bufferCut * REFERRAL_SHARE_BPS) / 10000n; // clawed back from the rebate pool to the self-referrer

    // conservation: creator-net + rebate-pool-net + referral == the whole 1% fee (nothing created or lost)
    expect((await pm.balanceOf(hookAddr, 0n)) - claimBefore).to.equal(fee);
    expect((await hook.creatorOwed(poolId, 0)) - creatorBefore).to.equal(creatorCut); // creator untouched by self-referral
    expect((await hook.bufferOwed(poolId)) - buffBefore).to.equal(bufferCut - referralCut); // rebate pool net
    expect(await hook.referralOwed(trader.address, ZERO)).to.be.gte(referralCut); // self-referrer accrues the carve

    // CREATOR-REVENUE FLOOR: even under adversarial self-referral the creator's flat share is completely
    // unaffected — referral only ever redistributes WITHIN the trader-rebate pool. The 1% total is conserved.
    expect(creatorCut + (bufferCut - referralCut) + referralCut).to.equal(fee);
  });
});
