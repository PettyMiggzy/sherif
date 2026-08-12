const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");

// ─────────────────────────────────────────────────────────────────────────────
// Feature 4 — RobinBlue stock-pad launch against the LIVE V4 stack, using a MockStock as the quote
// (a real Robinhood Stock Token can't be safely exercised in test). Proves the two-ERC20 seed mint,
// the token>stock ordering (quote=currency0), and the quoteIsStock hook wiring. Run:
//   FORK_RPC=<robinhood rpc> npx hardhat test test/fork/StockPadFactory.launch.fork.test.js
// NOTE: this validates the MECHANICS. Before mainnet, the stock path still needs a fork test against a
// REAL stock beacon + its own security audit + the securities/legal launch gates.
// ─────────────────────────────────────────────────────────────────────────────

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const POSITION_MANAGER = "0x174c1130aD96Ff0BB5492dD2BF81ccd549572EFA";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const SQRT_1_1 = 79228162514264337593543950336n;
const FLAG_MASK = 0x3fffn, HOOK_FLAGS = 0xccn;
const abi = ethers.AbiCoder.defaultAbiCoder();

describe("StockPadFactory — RobinBlue launch on live 0x8366 (MockStock quote)", function () {
  before(function () {
    if (!process.env.FORK_RPC) this.skip();
  });

  it("launches a stock-quoted pad: token sorts above the stock, quoteIsStock set, LockVault owns the NFT", async () => {
    const [deployer, platform, creator] = await ethers.getSigners();

    const dep = await (await ethers.getContractFactory("DeterministicDeployer")).deploy();
    const reg = await (await ethers.getContractFactory("FeeWalletRegistry")).deploy(platform.address, deployer.address);
    const lockVault = await (await ethers.getContractFactory("LockVault")).deploy(POSITION_MANAGER, await reg.getAddress());
    const factory = await (await ethers.getContractFactory("StockPadFactory")).deploy(
      POOL_MANAGER, POSITION_MANAGER, PERMIT2, await dep.getAddress(), await reg.getAddress(), await lockVault.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());

    // MockStock as the quote + a gated adapter over it
    const stockReg = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    const stock = await (await ethers.getContractFactory("MockStock")).connect(deployer).deploy(await stockReg.getAddress(), 10n ** 27n);
    const adapter = await (await ethers.getContractFactory("StockQuoteAdapter")).deploy(await stock.getAddress(), await stockReg.getAddress());
    const stockAddr = (await stock.getAddress()).toLowerCase();

    const cfg = {
      name: "Robin NVDA", symbol: "rNVDA", decimals: 18,
      supply: 10n ** 24n, lpTokenAmount: 5n * 10n ** 23n, stockSeed: 10n ** 21n,
      sqrtPriceX96: SQRT_1_1, tickSpacing: 60, fee: 3000,
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, guardWindow: 3600,
      adapter: await adapter.getAddress(), creator: creator.address,
      floorRecipient: ethers.ZeroAddress, stakingRecipient: ethers.ZeroAddress,
    };

    // mine tokenSalt so the token address sorts ABOVE the stock (quote = currency0)
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenCtor = abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, cfg.decimals, cfg.supply, await factory.getAddress()]);
    const tokenInitHash = ethers.keccak256(ethers.concat([TokenF.bytecode, tokenCtor]));
    let tokenSalt, predictedToken;
    for (let i = 0n; ; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(await dep.getAddress(), s, tokenInitHash);
      if (a.toLowerCase() > stockAddr) { tokenSalt = s; predictedToken = a; break; }
    }

    // mine the hook salt (token in init-code)
    const HookF = await ethers.getContractFactory("RobinFeeHook");
    const { salt: hookSalt } = mineHookSalt(await dep.getAddress(), hookInitCode(HookF.bytecode, POOL_MANAGER, await factory.getAddress(), await reg.getAddress(), predictedToken));

    // approve the factory to pull the stock seed
    await stock.connect(deployer).approve(await factory.getAddress(), cfg.stockSeed);

    const ret = await factory.launch.staticCall(cfg, tokenSalt, hookSalt);
    await (await factory.launch(cfg, tokenSalt, hookSalt)).wait();
    const [token, hook, , lpTokenId] = ret;

    expect(token).to.equal(predictedToken);
    expect(token.toLowerCase() > stockAddr).to.equal(true); // token sorts above stock
    expect(BigInt(hook) & FLAG_MASK).to.equal(HOOK_FLAGS);

    const hookC = HookF.attach(hook);
    const conf = await hookC.config(await factory.poolOf(token));
    expect(conf.registered).to.equal(true);
    expect(conf.quoteIsStock).to.equal(true);
    expect(conf.guardAdapter).to.equal(await adapter.getAddress());

    const posm = await ethers.getContractAt("IPositionManagerMinimal", POSITION_MANAGER);
    expect(await posm.ownerOf(lpTokenId)).to.equal(await lockVault.getAddress());
  });
});
