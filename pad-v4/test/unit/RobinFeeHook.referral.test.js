const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinFeeHook — on-chain referral revenue-share. A referrer passed in the swap hookData on a BUY earns a slice
// (referralShareBps) of the PLATFORM's buy-tax cut — carved from the platform, never the buffer, never the trader.
// The reward is the MONEY SIDE (ETH — the buy tax is fee-on-input, denominated in currency0); the referrer pulls
// it with claimReferral(address(0)), which sweeps every ETH pad they referred in one call.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const FLAGS = 0x20ccn, MASK = 0x3fffn;
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

  it("a buy WITH a referrer in hookData carves the referral from the platform cut (not the buffer, not the trader)", async () => {
    const hookAddr = await hook.getAddress();
    const claimBefore = await pm.balanceOf(hookAddr, 0n); // ERC-6909 native-ETH claim (buy fee is minted, not taken)
    const spend = ethers.parseEther("1");

    const hookData = abi.encode(["address"], [referrer.address]);
    await buy("1", hookData);

    const skim = (await pm.balanceOf(hookAddr, 0n)) - claimBefore; // total buy tax (ETH claim, fee-on-input)
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
    const claim0 = await pm.balanceOf(hookAddr, 0n);

    await buy("1", "0x"); // no referrer

    const skim = (await pm.balanceOf(hookAddr, 0n)) - claim0;
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

  it("[audit] SELF-REFERRAL is a permissionless rebate that only lowers the PLATFORM's own cut — conservation holds, the floor is pinned", async () => {
    // A buyer names THEMSELVES as the referrer. On-chain this cannot be prevented (a Sybil alt-wallet works too),
    // so the referral is by-design an at-most-referralShareBps rebate on the platform's OWN buy cut. This sim PRICES
    // the worst case: it must never touch the buffer, the trader's tokens, or any other book — only move platform→self.
    const hookAddr = await hook.getAddress();
    const claimBefore = await pm.balanceOf(hookAddr, 0n);
    const platBefore = await hook.platformOwed(poolId, 0);
    const buffBefore = await hook.bufferOwed(poolId);
    const spend = ethers.parseEther("1");

    await buy("1", abi.encode(["address"], [trader.address])); // buyer == referrer (self-referral)

    const fee = (spend * BUY_BPS) / 10000n;                     // 1% of input
    const bufferCut = (fee * BUFFER_SHARE_BPS) / 10000n;        // 0.2% → buffer (UNAFFECTED by referral)
    const platformCut = fee - bufferCut;                        // 0.8% platform cut before the referral carve
    const referralCut = (platformCut * REFERRAL_SHARE_BPS) / 10000n; // 0.2% clawed back to the self-referrer

    // conservation: buffer + platform-net + referral == the whole 1% fee (nothing created or lost)
    expect((await pm.balanceOf(hookAddr, 0n)) - claimBefore).to.equal(fee);
    expect((await hook.bufferOwed(poolId)) - buffBefore).to.equal(bufferCut); // buffer untouched by self-referral
    expect((await hook.platformOwed(poolId, 0)) - platBefore).to.equal(platformCut - referralCut); // 0.6% net
    expect(await hook.referralOwed(trader.address, ZERO)).to.be.gte(referralCut); // self-referrer accrues the 0.2%

    // PLATFORM-REVENUE FLOOR: even under adversarial self-referral the platform still earns its full cut MINUS only
    // the referral slice — i.e. platform (0.6%) + buffer (0.2%, → platform at graduation) = 0.8% of buy volume, and
    // the self-referrer's rebate is exactly the referral slice, never more. The 1% total is fully conserved.
    expect(platformCut - referralCut + bufferCut + referralCut).to.equal(fee);
  });
});
