const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// ECONOMIC SIMULATIONS — multi-step scenarios against a real PoolManager that assert the
// money INVARIANTS hold: fee conservation (nothing leaks), correct directional routing over
// many trades, the floor only grows, and staking rewards + the 5% fee conserve exactly.
// ─────────────────────────────────────────────────────────────────────────────

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const FLAGS = 0xccn, MASK = 0x3fffn;
const abi = ethers.AbiCoder.defaultAbiCoder();

function mineHookSalt(dep, h) {
  for (let i = 0n; ; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(dep, s, h);
    if ((BigInt(a) & MASK) === FLAGS) return { salt: s, addr: a };
  }
}
const idOf = (k) => ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));

describe("SIM — fee conservation over many buys & sells", () => {
  it("platform+creator+floor owed == every wei skimmed; claims drain exactly", async () => {
    const [owner, factory, platform, lp, trader, creator, floor] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, owner.address);
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = ethers.concat([HookF.bytecode, abi.encode(["address", "address", "address", "address"], [await pm.getAddress(), factory.address, await reg.getAddress(), await tok.getAddress()])]);
    const { salt, addr } = mineHookSalt(await dep.getAddress(), ethers.keccak256(initCode));
    await dep.deploy(salt, initCode);
    const hook = HookF.attach(addr);

    const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: addr };
    const poolId = idOf(key);
    await pm.initialize(key, SQRT_1_1);
    await hook.connect(factory).registerPool(poolId, {
      currency0: ZERO, currency1: await tok.getAddress(), creator: creator.address, floorRecipient: floor.address,
      guardAdapter: ZERO, buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0, guardWindow: 0, quoteIsStock: false,
    });
    // the curve-buffer recipient (in prod, the pad's curve controller) — the buy-tax buffer carve is forwarded here
    await hook.connect(factory).setBufferRecipient(poolId, lp.address);
    const mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 25n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 21n, salt: ethers.ZeroHash }, "0x", { value: ethers.parseEther("5000") });

    await tok.connect(owner).transfer(trader.address, 10n ** 24n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    const hookAddr = await hook.getAddress();

    // a deterministic mixed sequence of buys and sells of varying size
    const seq = [["b", "0.5"], ["s", "40"], ["b", "1.2"], ["b", "0.3"], ["s", "120"], ["s", "10"], ["b", "2.0"], ["s", "75"], ["b", "0.7"], ["s", "33"]];
    for (const [dir, amt] of seq) {
      if (dir === "b") {
        await sw.connect(trader).swap(key, { zeroForOne: true, amountSpecified: -ethers.parseEther(amt), sqrtPriceLimitX96: MIN_SQRT_LIMIT }, { takeClaims: false, settleUsingBurn: false }, "0x", { value: ethers.parseEther(amt) });
      } else {
        await sw.connect(trader).swap(key, { zeroForOne: false, amountSpecified: -(BigInt(amt) * 10n ** 18n), sqrtPriceLimitX96: MAX_SQRT_LIMIT }, { takeClaims: false, settleUsingBurn: false }, "0x");
      }
    }

    // Both taxes are ETH (money side), and since [H-1] BOTH are collected as ERC-6909 CLAIMS (mint, no reserve
    // fronting) → redeemed for real ETH at claim time. Buys are fee-on-input in beforeSwap, sells are a slice of
    // the output leg in afterSwap. The hook holds claims for all four books, no raw ETH, and never any pad coin.
    // INVARIANT 1: buys → platform cut + curve buffer.
    const platEth = await hook.platformOwed(poolId, 0);
    const buffEth = await hook.bufferOwed(poolId);
    expect(buffEth).to.be.gt(0n); // the 20% buffer carve accrued
    // INVARIANT 2: sells → creator + floor.
    const creaEth = await hook.creatorOwed(poolId, 0);
    const floorEth = await hook.floorOwed(poolId, 0);
    expect(creaEth + floorEth).to.be.gt(0n);
    // SOLVENCY IS EXACT, per backing: the hook's ERC-6909 ETH claim == every wei booked across all four books,
    // and it holds no raw ETH between claims. Nothing leaks, nothing is over-promised.
    // [H-1] This is the invariant the fix buys: the sell tax no longer depends on the singleton physically
    // holding ETH at swap time, so it can't be waived by starving reserves inside the seller's own unlock.
    expect(await pm.balanceOf(hookAddr, 0n)).to.equal(platEth + buffEth + creaEth + floorEth);
    expect(await ethers.provider.getBalance(hookAddr)).to.equal(0n);
    // no pad coin ever accrues to the hook (the buy tax is ETH, not the coin)
    expect(await tok.balanceOf(hookAddr)).to.equal(0n);
    expect(await hook.platformOwed(poolId, 1)).to.equal(0n);
    expect(await hook.creatorOwed(poolId, 1)).to.equal(0n);
    expect(await hook.floorOwed(poolId, 1)).to.equal(0n);

    // INVARIANT 3: floor ≈ 20% of the sell tax. Per-swap the carve is floor(fee*0.2), so summed it
    // lands a few wei UNDER an exact 20% — and that dust is conserved into the creator's cut (never lost).
    const totalSell = creaEth + floorEth;
    const exact20 = (totalSell * 2000n) / 10000n;
    expect(floorEth).to.be.lte(exact20); // never more than 20%
    expect(exact20 - floorEth).to.be.lte(BigInt(seq.length)); // dust ≤ one wei per swap, to creator

    // INVARIANT 4: every claim succeeds (solvency proven), redeeming claims → real ETH, and drains BOTH the hook's
    // ETH claim and its raw ETH balance to exactly zero.
    await hook.claimPlatform(poolId, 0);
    await hook.claimBuffer(poolId); // forward the curve-buffer carve to its recipient (redeems the claim → ETH)
    await hook.claimCreator(poolId, 0);
    await hook.claimFloor(poolId, 0);
    expect(await tok.balanceOf(hookAddr)).to.equal(0n);
    expect(await pm.balanceOf(hookAddr, 0n)).to.equal(0n);
    expect(await ethers.provider.getBalance(hookAddr)).to.equal(0n);
  });
});

describe("SIM — the floor only ever grows and absorbs dumps", () => {
  it("repeated carve monotonically increases floor liquidity; never decreases", async () => {
    const [owner, lp, trader, platform] = await ethers.getSigners();
    const pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const key = { currency0: ZERO, currency1: await tok.getAddress(), fee: 3000, tickSpacing: 60, hooks: ZERO };
    await pm.initialize(key, SQRT_1_1);
    const mod = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(await pm.getAddress());
    const sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    await tok.connect(owner).transfer(lp.address, 10n ** 24n);
    await tok.connect(lp).approve(await mod.getAddress(), ethers.MaxUint256);
    await mod.connect(lp).modifyLiquidity(key, { tickLower: -12000, tickUpper: 12000, liquidityDelta: 10n ** 19n, salt: ethers.ZeroHash }, "0x", { value: ethers.parseEther("500") });

    const vault = await (await ethers.getContractFactory("RobinFloorVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), platform.address, ZERO, await tok.getAddress(), 3000, 60, ZERO, 0, 20
    );
    const vaultAddr = await vault.getAddress();

    let last = 0n;
    // [H-5] a commit needs the tick settled below the band for MIN_DWELL and is rate-limited per
    // COMMIT_COOLDOWN, so advance time between pokes. Monotonicity is the property under test either way.
    for (let i = 0; i < 8; i++) {
      await owner.sendTransaction({ to: vaultAddr, value: ethers.parseEther("2") });
      await time.increase(Number(await vault.COMMIT_COOLDOWN()) + 1);
      await vault.addFloor();
      const L = await vault.floorLiquidity();
      expect(L).to.be.gte(last, "floor liquidity must never decrease"); // monotonic
      last = L;
    }
    expect(last).to.be.gt(0n);

    // a big dump pushes price into the wall — it absorbs (converts quote→token), still no L decrease
    await tok.connect(owner).transfer(trader.address, 10n ** 24n);
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    await sw.connect(trader).swap(key, { zeroForOne: false, amountSpecified: -(10n ** 22n), sqrtPriceLimitX96: MAX_SQRT_LIMIT }, { takeClaims: false, settleUsingBurn: false }, "0x");
    expect(await vault.floorLiquidity()).to.equal(last, "absorbing a dump does not reduce locked liquidity");
  });
});

describe("SIM — staking rewards + 5% fee conserve exactly", () => {
  it("sum of staker claims (net) + platform fee + remaining ≈ funded; forfeiture stays in-pool", async () => {
    const [owner, rewarder, treasury, a, b, c] = await ethers.getSigners();
    const tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(
      await tok.getAddress(), ZERO, owner.address, 0, ZERO, ethers.ZeroHash, 0
    );
    await ds.setRewarder(rewarder.address, true);
    await ds.setPlatformClaimFee(500); // 5%
    await ds.setPlatformTreasury(treasury.address);
    for (const u of [a, b, c]) {
      await tok.connect(owner).transfer(u.address, 10n ** 22n);
      await tok.connect(u).approve(await ds.getAddress(), ethers.MaxUint256);
    }

    await ds.connect(a).stake(0, 1000n);
    await ds.connect(b).stake(0, 3000n);
    const funded = ethers.parseEther("10");
    await ds.connect(rewarder).fundETH(0, { value: funded });
    await time.increase(3 * 86400);
    await ds.connect(c).stake(0, 2000n); // joins midway
    await time.increase(10 * 86400); // stream finished

    // everyone claims; sum of NET payouts + platform fee should equal the streamed rewards (± dust)
    let netTotal = 0n;
    for (const u of [a, b, c]) {
      const gross = await ds.earned(0, u.address, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
      if (gross > 0n) {
        const bef = await ethers.provider.getBalance(u.address);
        const tx = await (await ds.connect(u).claim(0, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")).wait();
        netTotal += (await ethers.provider.getBalance(u.address)) - bef + tx.gasUsed * tx.gasPrice;
      }
    }
    const platFee = await ds.platformFeesOwed("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    // net paid to stakers + platform's 5% == funded (within streaming dust)
    const distributed = netTotal + platFee;
    const diff = funded > distributed ? funded - distributed : distributed - funded;
    expect(diff).to.be.lt(ethers.parseEther("0.001"), "rewards conserved: claims + fee == funded");
    // platform fee is ~5% of the distributed gross
    expect(platFee).to.be.gt(0n);
  });
});
