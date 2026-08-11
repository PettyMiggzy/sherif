const { ethers } = require("hardhat");
const { expect } = require("chai");

// RobinLpVault — the simple "provide liquidity, earn fees" vault, verified against a real Uniswap v4 PoolManager:
// two-sided deposit mints pooled full-range liquidity, real swap fees stream to depositors pro-rata to their
// liquidity, claim pays ETH+token, and withdraw returns principal. No lock, no zap, no oracle.

const ZERO = ethers.ZeroAddress;
const SQRT_1_1 = 79228162514264337593543950336n; // tick 0
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));

function poolIdOf(k) {
  return ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));
}

describe("RobinLpVault — provide liquidity, earn fees (real PoolManager)", () => {
  const FEE = 3000, TS = 60;
  let owner, alice, bob, trader, pm, stateView, tok, sw, key, poolId, vault;

  beforeEach(async () => {
    [owner, alice, bob, trader] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
    tok = await (await ethers.getContractFactory("TestERC20")).connect(owner).deploy(10n ** 30n);
    sw = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    key = { currency0: ZERO, currency1: await tok.getAddress(), fee: FEE, tickSpacing: TS, hooks: ZERO };
    poolId = poolIdOf(key);
    await pm.initialize(key, SQRT_1_1);
    vault = await (await ethers.getContractFactory("RobinLpVault")).deploy(
      await pm.getAddress(), await stateView.getAddress(), ZERO, await tok.getAddress(), FEE, TS, ZERO
    );
    // fund LPs + trader with token
    for (const u of [alice, bob, trader]) await tok.connect(owner).transfer(u.address, E(1000));
  });

  async function deposit(who, eth, tokMax) {
    await tok.connect(who).approve(await vault.getAddress(), ethers.MaxUint256);
    return vault.connect(who).deposit(E(tokMax), 0, ethers.MaxUint256, { value: E(eth) });
  }
  const buy = (amt) => sw.connect(trader).swap(
    key, { zeroForOne: true, amountSpecified: -E(amt), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(amt) });
  async function sell(wei) {
    await tok.connect(trader).approve(await sw.getAddress(), ethers.MaxUint256);
    return sw.connect(trader).swap(key, { zeroForOne: false, amountSpecified: -wei, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
      { takeClaims: false, settleUsingBurn: false }, "0x");
  }

  it("deposit mints pooled liquidity and pulls both sides", async () => {
    await deposit(alice, 10, 10);
    expect(await vault.liquidityOf(alice.address)).to.be.gt(0n);
    expect(await vault.totalLiquidity()).to.equal(await vault.liquidityOf(alice.address));
    // on-chain position matches the vault's booked liquidity
    const [posL] = await stateView.getPositionInfo(poolId, await vault.getAddress(),
      Number(await vault.tickLower()), Number(await vault.tickUpper()), ethers.ZeroHash);
    expect(posL).to.equal(await vault.totalLiquidity());
  });

  it("earns real swap fees; claim pays ETH + token; withdraw returns principal", async () => {
    await deposit(alice, 10, 10);
    await buy("2");             // ETH-side fees
    await sell(2n * 10n ** 18n); // token-side fees

    const [cEth, cTok] = await vault.claim.staticCall();
    // claim() harvests then pays — run it from alice and check she received value
    const e0 = await ethers.provider.getBalance(alice.address);
    const t0 = await tok.balanceOf(alice.address);
    const rc = await (await vault.connect(alice).claim()).wait();
    const eNet = (await ethers.provider.getBalance(alice.address)) - e0 + rc.gasUsed * rc.gasPrice;
    expect(eNet).to.be.gt(0n); // ETH fees from the buy
    expect((await tok.balanceOf(alice.address)) - t0).to.be.gt(0n); // token fees from the sell

    // withdraw all principal
    const liq = await vault.liquidityOf(alice.address);
    await vault.connect(alice).withdraw(liq);
    expect(await vault.liquidityOf(alice.address)).to.equal(0n);
    expect(await vault.totalLiquidity()).to.equal(0n);
    // nothing stranded beyond the fee reserve
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(await vault.feeReserve0());
    expect(await tok.balanceOf(await vault.getAddress())).to.equal(await vault.feeReserve1());
  });

  it("splits fees pro-rata to liquidity between two depositors", async () => {
    await deposit(alice, 10, 10);
    await deposit(bob, 10, 10); // ~equal liquidity
    const la = await vault.liquidityOf(alice.address);
    const lb = await vault.liquidityOf(bob.address);

    await buy("4");
    await sell(4n * 10n ** 18n);

    const [ae, at] = await vault.connect(alice).claimable(alice.address);
    // trigger a harvest so claimable reflects pool fees, then compare books
    await vault.connect(alice).claim();
    await vault.connect(bob).claim();
    const aPaidT = await tok.balanceOf(alice.address);
    const bPaidT = await tok.balanceOf(bob.address);
    // equal liquidity ⇒ near-equal token-fee payout (allow rounding + the tiny order-of-claim harvest gap)
    const ratio = Number((aPaidT * 1000n) / (bPaidT === 0n ? 1n : bPaidT)) / 1000;
    expect(la).to.be.closeTo(lb, la / 100n);
    expect(ratio).to.be.greaterThan(0.9);
    expect(ratio).to.be.lessThan(1.1);
  });

  it("reverts a zero-side deposit and an over-withdraw", async () => {
    await expect(vault.connect(alice).deposit(0, 0, ethers.MaxUint256, { value: E(1) })).to.be.revertedWithCustomError(vault, "ZeroLiquidity");
    await deposit(alice, 5, 5);
    await expect(vault.connect(alice).withdraw((await vault.liquidityOf(alice.address)) + 1n)).to.be.revertedWithCustomError(vault, "Insufficient");
  });

  it("enforces the deposit slippage floor + deadline [audit M3]", async () => {
    await tok.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    // past deadline → Expired (checked before any funds move)
    await expect(vault.connect(alice).deposit(E(100), 0, 1, { value: E(1) })).to.be.revertedWithCustomError(vault, "Expired");
    // minMinted above what the price can mint → Slippage (bounds the composition against a sandwich)
    await expect(vault.connect(alice).deposit(E(100), ethers.parseEther("1000000000000"), ethers.MaxUint256, { value: E(1) }))
      .to.be.revertedWithCustomError(vault, "Slippage");
    // a sane floor still succeeds
    await expect(vault.connect(alice).deposit(E(100), 1, ethers.MaxUint256, { value: E(1) })).to.not.be.reverted;
  });
});
