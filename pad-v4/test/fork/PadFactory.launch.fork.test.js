const { ethers } = require("hardhat");
const abi = ethers.AbiCoder.defaultAbiCoder();
const { expect } = require("chai");
const { mineHookSalt, hookInitCode, HOOK_FLAGS, FLAG_MASK } = require("../../scripts/mine");

// ─────────────────────────────────────────────────────────────────────────────
// Full one-tx ETH-pad launch against the LIVE V4 stack (PoolManager 0x8366 +
// PositionManager 0x174c + Permit2). This is the only place the factory's seed-LP
// mint path is exercised end-to-end (it needs the real PositionManager). Run:
//   FORK_RPC=<robinhood rpc> npx hardhat test test/fork/PadFactory.launch.fork.test.js
// ─────────────────────────────────────────────────────────────────────────────

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const SQRT_1_1 = 79228162514264337593543950336n;

describe("PadFactory — full ETH-pad launch on live 0x8366", function () {
  before(function () {
    if (!process.env.FORK_RPC) this.skip();
  });

  it("launches: token+hook deployed, hook flags 0xC4, pool registered, LockVault owns the seed NFT", async () => {
    const [deployer, platform, creator] = await ethers.getSigners();

    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(POSITION_MANAGER, await reg.getAddress());
    const factory = await (await ethers.getContractFactory("PadFactory")).deploy(
      POOL_MANAGER, POSITION_MANAGER, PERMIT2, await dep.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());

    const cfg = {
      name: "Robin Test", symbol: "RTEST", decimals: 18,
      supply: 10n ** 24n, lpTokenAmount: 5n * 10n ** 23n,
      sqrtPriceX96: SQRT_1_1, tickSpacing: 60, fee: 3000,
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000,
      creator: creator.address, floorRecipient: ethers.ZeroAddress, stakingRecipient: ethers.ZeroAddress,
    };
    const tokenSalt = ethers.id("robin-blue-1");

    // predict the token address (deployed by the factory via CREATE2) so we can build the hook init-code
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenInit = ethers.concat([
      TokenF.bytecode,
      abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await factory.getAddress()]),
    ]);
    const predictedToken = ethers.getCreate2Address(await dep.getAddress(), tokenSalt, ethers.keccak256(tokenInit));

    // mine the hook salt against the exact init-code the factory will build (includes the token)
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const initCode = hookInitCode(HookF.bytecode, POOL_MANAGER, await factory.getAddress(), await reg.getAddress(), predictedToken);
    const { salt: hookSalt } = mineHookSalt(await dep.getAddress(), initCode);

    const seedEth = ethers.parseEther("10");
    const ret = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, { value: seedEth });
    await (await factory.launch(cfg, tokenSalt, hookSalt, { value: seedEth })).wait();

    const [token, hook, , lpTokenId] = ret;
    expect(BigInt(hook) & FLAG_MASK).to.equal(HOOK_FLAGS);

    // pool config bound on the hook
    const hookC = HookF.attach(hook);
    const poolId = await factory.poolOf(token);
    const conf = await hookC.config(poolId);
    expect(conf.registered).to.equal(true);
    expect(conf.creator).to.equal(creator.address);

    // LockVault owns the seed-LP NFT (locked forever)
    const posm = await ethers.getContractAt("IPositionManagerMinimal", POSITION_MANAGER);
    expect(await posm.ownerOf(lpTokenId)).to.equal(await lockVault.getAddress());

    // creator received the non-LP token remainder (>= supply - lpTokenAmount, since the seed may
    // consume less than lpTokenAmount when the ETH leg binds — M1 fix routes the true surplus)
    expect(token).to.equal(predictedToken);
    const tokenC = await ethers.getContractAt("PadToken", token);
    expect(await tokenC.balanceOf(creator.address)).to.be.gte(cfg.supply - cfg.lpTokenAmount);
  });
});
