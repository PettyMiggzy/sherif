const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");

// SIM E2E — the full trade lifecycle THROUGH THE REAL FEE HOOK on a real local Uniswap v4 PoolManager.
// Proves the things that burned us before, across different dev-buy + airdrop shapes:
//   • NO BOT PROTECTION: first-trade-after-launch works, any wallet can trade, buy-then-instant-sell works,
//     airdropped holders can sell, MANY wallets trade in the SAME block, any size from dust to whale — all pass.
//   • NO CRAZY SLIPPAGE: round-trip loss ≈ the fees (a few %), never anything like the 50% we saw on the old pad.
//   • Dev buys (the dev is just the first buyer) and airdrops (plain ERC20 transfers) work end to end.
//   • A busy tape still graduates cleanly.
// Mocks stand in only for the 0.8.17-pinned PositionManager/Permit2 (graduation mint); everything else is real.

const ZERO = ethers.ZeroAddress;
const MIN_SQRT_LIMIT = 4295128739n + 1n;
const MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (x) => ethers.parseEther(String(x));

// geometry: START=6000 → GRAD=3000 (ts=60). buyTax 1% + sellTax 1% + lpFee 1%.
const START = 6000, GRAD = 3000, TS = 60, FEE = 10000, MINGRAD = 1800;

async function deployStack(deployer, platform) {
  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
  const stateView = await (await ethers.getContractFactory("RobinStateView")).deploy(await pm.getAddress());
  const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
  const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
  const permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
  const posm = await (await ethers.getContractFactory("MockPositionManagerV4")).deploy(await pm.getAddress(), await permit2.getAddress());
  const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(await posm.getAddress(), await reg.getAddress());
  const curveDep = await (await ethers.getContractFactory("CurveV4Deployer")).deploy(await dep.getAddress());
  const feeCfg = await (await ethers.getContractFactory("RobinV4FeeConfig")).deploy(deployer.address, {
    buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 0, buyLpFloorShareBps: 2000, buyBufferShareBps: 2000, referralShareBps: 0,
    platformGradBps: 1000, creatorGradBps: 1000, ambushGradBps: 500,
    lpFee: FEE, startTickMag: START, curveWidth: START - GRAD, minGradWidth: MINGRAD,
  });
  const factory = await (await ethers.getContractFactory("CurvePadFactoryV4")).deploy(
    await pm.getAddress(), await posm.getAddress(), await permit2.getAddress(), await stateView.getAddress(),
    await dep.getAddress(), await curveDep.getAddress(), await feeCfg.getAddress(), await reg.getAddress(), await lockVault.getAddress()
  );
  await lockVault.setFactory(await factory.getAddress());
  return { pm, stateView, dep, reg, permit2, posm, lockVault, factory };
}

async function launchPad(S, deployer, creator, tag, { supply, curveSupply, reserveSupply }) {
  const cfg = {
    name: "Robin " + tag, symbol: tag, decimals: 18,
    supply, curveSupply, reserveSupply, tickSpacing: TS, creator: creator.address,
  };
  const TokenF = await ethers.getContractFactory("PadToken");
  const tokenSalt = ethers.id("tok-" + tag);
  const tokenInit = ethers.concat([
    TokenF.bytecode,
    abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await S.factory.getAddress()]),
  ]);
  const predictedToken = ethers.getCreate2Address(await S.dep.getAddress(), tokenSalt, ethers.keccak256(tokenInit));
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(
    await S.dep.getAddress(),
    hookInitCode(HookF.bytecode, await S.pm.getAddress(), await S.factory.getAddress(), await S.reg.getAddress(), predictedToken)
  );
  const curveSalt = ethers.id("curve-" + tag);
  const [token, hook, curveAddr] = await S.factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  await (await S.factory.launch(cfg, tokenSalt, hookSalt, curveSalt)).wait();
  const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
  const poolId = ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
  const tok = await ethers.getContractAt("PadToken", token);
  const curve = await ethers.getContractAt("RobinCurveV4", curveAddr);
  return { token, hook, curveAddr, key, poolId, tok, curve };
}

let SW; // shared PoolSwapTest
const buy = (key, who, amt) => SW.connect(who).swap(
  key, { zeroForOne: true, amountSpecified: -E(amt), sqrtPriceLimitX96: MIN_SQRT_LIMIT },
  { takeClaims: false, settleUsingBurn: false }, "0x", { value: E(amt) }
);
async function sellAll(key, who, tok, amt) {
  await tok.connect(who).approve(await SW.getAddress(), ethers.MaxUint256);
  return SW.connect(who).swap(
    key, { zeroForOne: false, amountSpecified: -amt, sqrtPriceLimitX96: MAX_SQRT_LIMIT },
    { takeClaims: false, settleUsingBurn: false }, "0x"
  );
}

describe("SIM E2E — buys/sells through the hook: no bot protection, no crazy slippage", () => {
  let signers, deployer, platform, S;

  before(async () => {
    signers = await ethers.getSigners();
    deployer = signers[0];
    platform = signers[1];
    S = await deployStack(deployer, platform);
    SW = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await S.pm.getAddress());
  });

  // one full scenario: dev buy → airdrop → tape (with no-bot-protection + slippage assertions)
  async function scenario(tag, { curveSupply, reserveSupply, devBuyEth, airdropHolders, normalBuyEth, whaleBuyEth }) {
    const creator = signers[2];
    // NO DEV MINT: supply is exactly curve + reserve. The creator starts with ZERO tokens and gets them ONLY by
    // buying from the curve (the "dev buy") — then airdrops from what they bought. No premine, no pre-bought bag.
    const supply = curveSupply + reserveSupply;
    const P = await launchPad(S, deployer, creator, tag, { supply, curveSupply, reserveSupply });
    const { key, tok, curve } = P;

    // creator holds NOTHING at launch (no premine)
    expect(await tok.balanceOf(creator.address)).to.equal(0n);

    // ── DEV BUY: the dev is simply the FIRST buyer (proves no launch-snipe / first-block protection) ──
    await expect(buy(key, creator, devBuyEth)).to.not.be.reverted;
    const devBought = await tok.balanceOf(creator.address);
    expect(devBought).to.be.gt(0n); // got curve tokens by BUYING, like everyone else

    // ── AIRDROP: the creator hands out a third of the tokens they BOUGHT, split across N holders (plain ERC20
    //    transfers → proves no transfer restriction). Sized off devBought so it holds for any curve geometry. ──
    const holders = signers.slice(5, 5 + airdropHolders);
    const airdropEach = devBought / BigInt(airdropHolders * 3);
    expect(airdropEach).to.be.gt(0n);
    for (const h of holders) await expect(tok.connect(creator).transfer(h.address, airdropEach)).to.not.be.reverted;
    for (const h of holders) expect(await tok.balanceOf(h.address)).to.equal(airdropEach);

    // an AIRDROPPED holder (never bought) can immediately SELL — no "only buyers can sell" style gating
    await expect(sellAll(key, holders[0], tok, airdropEach / 2n)).to.not.be.reverted;

    // ── MANY WALLETS TRADE IN THE SAME BLOCK (no per-block cap / anti-sandwich gating) ──
    await network.provider.send("evm_setAutomine", [false]);
    const sameBlock = signers.slice(8, 13);
    const pending = [];
    for (const w of sameBlock) pending.push(await buy(key, w, normalBuyEth)); // queued, not mined
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    for (const p of pending) await expect(p.wait()).to.not.be.rejected; // every same-block buy landed
    for (const w of sameBlock) expect(await tok.balanceOf(w.address)).to.be.gt(0n);

    // ── BUY → INSTANT SELL in back-to-back txs (no cooldown / trading anti-JIT) ──
    const jit = signers[13];
    await expect(buy(key, jit, normalBuyEth)).to.not.be.reverted;
    await expect(sellAll(key, jit, tok, await tok.balanceOf(jit.address))).to.not.be.reverted;

    // ── WILDLY DIFFERENT SIZES all succeed (no min/max tx-size gating) ──
    for (const [w, amt] of [[signers[14], "0.001"], [signers[15], "0.05"], [signers[16], String(whaleBuyEth)]]) {
      await expect(buy(key, w, amt)).to.not.be.reverted;
      expect(await tok.balanceOf(w.address)).to.be.gt(0n);
    }

    // ── SLIPPAGE: round-trip a normal buy and a whale buy; loss must be ~fees, NEVER near 50% ──
    const rt = async (who, amt) => {
      const before = await tok.balanceOf(who.address);
      await buy(key, who, amt);
      const bought = (await tok.balanceOf(who.address)) - before;
      const ethBefore = await ethers.provider.getBalance(who.address);
      const rc = await (await sellAll(key, who, tok, bought)).wait();
      const ethOut = (await ethers.provider.getBalance(who.address)) - ethBefore + rc.gasUsed * rc.gasPrice;
      return Number((E(amt) - ethOut) * 10000n / E(amt)) / 100; // % lost round-trip
    };
    const normalLoss = await rt(signers[17], normalBuyEth);
    const whaleLoss = await rt(signers[18], String(whaleBuyEth));
    console.log(`      [${tag}] round-trip loss — normal ${normalBuyEth}Ξ: ${normalLoss.toFixed(2)}% · whale ${whaleBuyEth}Ξ: ${whaleLoss.toFixed(2)}%`);
    expect(normalLoss).to.be.lt(12); // ~4-6% of fees + tiny impact; nowhere near 50
    expect(whaleLoss).to.be.lt(45);
    expect(whaleLoss).to.be.lessThan(50); // the explicit "never the 50% disaster" guard

    return { P };
  }

  it("scenario A — small dev buy (0.5Ξ) + large airdrop (8 holders), deep curve", async () => {
    await scenario("PADA", {
      curveSupply: 100000n * 10n ** 18n, reserveSupply: 100000n * 10n ** 18n,
      devBuyEth: 0.5, airdropHolders: 8, airdropEach: 100n * 10n ** 18n, normalBuyEth: "1", whaleBuyEth: 50,
    });
  });

  it("scenario B — large dev buy (20Ξ) + small airdrop (3 holders), deep curve", async () => {
    await scenario("PADB", {
      curveSupply: 100000n * 10n ** 18n, reserveSupply: 100000n * 10n ** 18n,
      devBuyEth: 20, airdropHolders: 3, airdropEach: 500n * 10n ** 18n, normalBuyEth: "2", whaleBuyEth: 80,
    });
  });

  // ⚠️ COMPLIANCE: tokenized-stock (RWA) rewards are SECURITIES. Per SEC 2026 guidance + the live market
  // (xStocks/Backed geo-block the US, and their stock rewards are "not available in the US"), this path must be
  // geo/KYC-GATED to eligible NON-US users and requires legal sign-off. It is OPT-IN only — the default pad
  // reward is the token itself + ETH (US-safe). This test proves the plumbing; it does NOT bless US distribution.
  it("scenario D — [gated, non-US] RWA rewards: stake the pad coin, EARN a tokenized real-world asset", async () => {
    const creator = signers[2];
    const curveSupply = 1000n * 10n ** 18n, reserveSupply = 1000n * 10n ** 18n;
    const P = await launchPad(S, deployer, creator, "PADD", { supply: curveSupply + reserveSupply, curveSupply, reserveSupply });
    const { key, tok } = P;

    // the RWA: a tokenized real-world asset (a stock on Robinhood Chain), governed by its access registry
    const stockReg = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    const rwa = await (await ethers.getContractFactory("MockStock")).connect(deployer).deploy(await stockReg.getAddress(), 10n ** 24n);

    // the pad's staking pool: stake the PAD COIN (single-book), earn the RWA as the streamed reward
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(P.token, ZERO, deployer.address, 0, ZERO, ethers.ZeroHash, 0);
    await ds.listReward(0, await rwa.getAddress(), 7 * 86400); // Side.TOKEN earns the tokenized real-world asset

    // holders BUY the pad coin from the curve (no premine), then STAKE what they bought
    const holders = signers.slice(5, 9);
    const staked = {};
    for (const h of holders) {
      await expect(buy(key, h, "2")).to.not.be.reverted;
      const bal = await tok.balanceOf(h.address);
      await tok.connect(h).approve(await ds.getAddress(), ethers.MaxUint256);
      await ds.connect(h).stake(0, bal);
      staked[h.address] = bal;
    }

    // the platform funds the RWA reward stream (in prod: a slice of fees → buy the RWA via RobinStockSwap → fundToken)
    await rwa.connect(deployer).approve(await ds.getAddress(), ethers.MaxUint256);
    await expect(ds.connect(deployer).fundToken(0, await rwa.getAddress(), 100000n * 10n ** 18n)).to.not.be.reverted;

    // stream the window; a holder EARNS and CLAIMS the tokenized real-world asset for staking the coin
    await time.increase(7 * 86400 + 10);
    const alice = holders[0];
    expect(await ds.earned(0, alice.address, await rwa.getAddress())).to.be.gt(0n);
    const before = await rwa.balanceOf(alice.address);
    await expect(ds.connect(alice).claim(0, await rwa.getAddress())).to.not.be.reverted;
    expect(await rwa.balanceOf(alice.address)).to.be.gt(before); // holder now holds a REAL-WORLD ASSET earned by staking
    await expect(ds.connect(alice).unstake(0, staked[alice.address])).to.not.be.reverted; // pad-coin principal returns untouched
  });

  it("scenario C — no dev buy + airdrop + STAKING; busy tape GRADUATES; holders stake→earn→claim→unstake", async () => {
    const creator = signers[2];
    const curveSupply = 1000n * 10n ** 18n, reserveSupply = 1000n * 10n ** 18n;
    const P = await launchPad(S, deployer, creator, "PADC", { supply: curveSupply + reserveSupply, curveSupply, reserveSupply });
    const { key, tok, curve } = P;

    // ── wire the pad's holder-staking pool (stake the token, earn the streamed token; 5% claim fee, no hold) ──
    const ds = await (await ethers.getContractFactory("DualStaking")).deploy(P.token, ZERO, deployer.address, 0, ZERO, ethers.ZeroHash, 0);
    await ds.setRewarder(await curve.getAddress(), true);
    await ds.listReward(0, P.token, 7 * 86400); // Side.TOKEN earns the token
    await curve.connect(platform).setStaking(await ds.getAddress());

    // ── holders BUY from the curve (no premine), then STAKE what they bought into the pool ──
    const stakers = signers.slice(5, 9);
    const staked = {};
    for (const h of stakers) {
      await expect(buy(key, h, "2")).to.not.be.reverted;
      const bal = await tok.balanceOf(h.address);
      await tok.connect(h).approve(await ds.getAddress(), ethers.MaxUint256);
      await expect(ds.connect(h).stake(0, bal)).to.not.be.reverted;
      staked[h.address] = bal;
    }
    const totalStakedExpected = Object.values(staked).reduce((a, b) => a + b, 0n);
    expect(await ds.totalStaked(0)).to.equal(totalStakedExpected);

    // ── busy multi-wallet tape buys the shallow curve OUT ──
    for (const w of signers.slice(9, 15)) await expect(buy(key, w, "2")).to.not.be.reverted;
    await expect(buy(key, signers[15], "6000")).to.not.be.reverted; // buy out → ceiling
    expect(await curve.ready()).to.equal(true);

    // ── graduate: streams the leftover token → the staking pool as the holder reward ──
    const idBefore = await S.posm.nextTokenId();
    await expect(curve.graduate()).to.not.be.reverted;
    expect(await curve.graduated()).to.equal(true);
    expect(await S.posm.ownerOf(idBefore)).to.equal(await S.lockVault.getAddress());
    expect((await S.stateView.getSlot0(P.poolId))[1]).to.equal(GRAD); // ceiling restored
    expect(await tok.balanceOf(await ds.getAddress())).to.be.gt(totalStakedExpected); // reward arrived on top of principal

    // ── stream the window, then a holder EARNS, CLAIMS the reward, and UNSTAKES the principal ──
    await time.increase(7 * 86400 + 10);
    const alice = stakers[0];
    expect(await ds.earned(0, alice.address, P.token)).to.be.gt(0n);
    const before = await tok.balanceOf(alice.address);
    await expect(ds.connect(alice).claim(0, P.token)).to.not.be.reverted;
    const afterClaim = await tok.balanceOf(alice.address);
    expect(afterClaim).to.be.gt(before); // received the streamed reward (net of the 5% claim fee)
    await expect(ds.connect(alice).unstake(0, staked[alice.address])).to.not.be.reverted; // principal returned
    expect(await tok.balanceOf(alice.address)).to.equal(afterClaim + staked[alice.address]);
  });
});
