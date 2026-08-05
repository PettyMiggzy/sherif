const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ONE = 10n ** 18n;
const WEEK = 7 * 86400;
const FEE = 3000;

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}
async function jump(secs) {
  await network.provider.send("evm_setNextBlockTimestamp", [(await now()) + secs]);
  await network.provider.send("evm_mine", []);
}

describe("RewardConverter", () => {
  async function setup() {
    const [owner, keeper, user, treasury] = await ethers.getSigners();

    const WETH = await (await ethers.getContractFactory("RsWETH9")).deploy();
    const router = await (await ethers.getContractFactory("MockSwapRouter02")).deploy(await WETH.getAddress());
    const STOCK = await (await ethers.getContractFactory("RsERC20")).deploy("Apple RH", "AAPL");
    const ROBIN = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);

    const staking = await (await ethers.getContractFactory("RobinStaking")).deploy(
      await ROBIN.getAddress(),
      owner.address
    );
    await staking.listReward(await STOCK.getAddress(), WEEK);

    const conv = await (await ethers.getContractFactory("RewardConverter")).deploy(
      await WETH.getAddress(),
      await router.getAddress(),
      owner.address
    );
    await conv.setKeeper(keeper.address, true);
    await staking.setRewarder(await conv.getAddress(), true);

    // user stakes ROBIN
    await ROBIN.transfer(user.address, 1000n * ONE);
    await ROBIN.connect(user).approve(await staking.getAddress(), ethers.MaxUint256);
    await staking.connect(user).stake(1000n * ONE);

    return { owner, keeper, user, treasury, WETH, router, STOCK, ROBIN, staking, conv };
  }

  it("converts ETH→stock and streams it into the pool", async () => {
    const { keeper, user, STOCK, staking, conv } = await setup();
    const cAddr = await conv.getAddress();
    // fund converter with 2 ETH of fee revenue
    await keeper.sendTransaction({ to: cAddr, value: 2n * ONE });
    // router rate = 1:1, so 2 ETH -> 2 STOCK; minOut a hair under
    await conv.connect(keeper).convertAndFund(
      await staking.getAddress(),
      await STOCK.getAddress(),
      FEE,
      2n * ONE,
      (2n * ONE * 99n) / 100n
    );
    await jump(WEEK + 5);
    const earned = await staking.earned(user.address, await STOCK.getAddress());
    expect(earned).to.be.closeTo(2n * ONE, 10n ** 12n);
    await staking.connect(user).claim(await STOCK.getAddress());
    expect(await STOCK.balanceOf(user.address)).to.be.closeTo(2n * ONE, 10n ** 12n);
  });

  it("reverts on slippage (minOut not met)", async () => {
    const { keeper, router, STOCK, staking, conv } = await setup();
    await keeper.sendTransaction({ to: await conv.getAddress(), value: ONE });
    await router.setRate(ONE / 2n); // 1 ETH -> 0.5 STOCK
    await expect(
      conv.connect(keeper).convertAndFund(await staking.getAddress(), await STOCK.getAddress(), FEE, ONE, ONE)
    ).to.be.reverted; // router's "Too little received"
  });

  it("fundEth streams plain ETH; fundToken streams pre-held tokens (illiquid path)", async () => {
    const { owner, keeper, user, STOCK, staking, conv } = await setup();
    const cAddr = await conv.getAddress();
    // fundEth
    await keeper.sendTransaction({ to: cAddr, value: 3n * ONE });
    await conv.connect(keeper).fundEth(await staking.getAddress(), 3n * ONE);
    // fundToken: mint stock straight to the converter (treasury-held), then stream it
    await STOCK.mint(cAddr, 100n * ONE);
    await conv.connect(keeper).fundToken(await staking.getAddress(), await STOCK.getAddress(), 100n * ONE);
    await jump(WEEK + 5);
    expect(await staking.earned(user.address, staking.ETH ? await staking.ETH() : 0)).to.be.closeTo(
      3n * ONE,
      10n ** 12n
    );
    expect(await staking.earned(user.address, await STOCK.getAddress())).to.be.closeTo(100n * ONE, 10n ** 11n);
  });

  it("only a keeper can convert/fund", async () => {
    const { user, STOCK, staking, conv } = await setup();
    await expect(
      conv.connect(user).convertAndFund(await staking.getAddress(), await STOCK.getAddress(), FEE, ONE, 1n)
    ).to.be.revertedWithCustomError(conv, "NotKeeper");
    await expect(conv.connect(user).fundEth(await staking.getAddress(), ONE)).to.be.revertedWithCustomError(
      conv,
      "NotKeeper"
    );
  });

  it("owner can recover stuck ETH and tokens", async () => {
    const { owner, keeper, treasury, STOCK, conv } = await setup();
    const cAddr = await conv.getAddress();
    await keeper.sendTransaction({ to: cAddr, value: ONE });
    await STOCK.mint(cAddr, 50n * ONE);
    await conv.connect(owner).recoverEth(treasury.address, ONE);
    await conv.connect(owner).recoverToken(await STOCK.getAddress(), treasury.address, 50n * ONE);
    expect(await STOCK.balanceOf(treasury.address)).to.equal(50n * ONE);
  });
});
