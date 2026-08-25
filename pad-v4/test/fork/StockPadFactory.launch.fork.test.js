const { ethers } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt, hookInitCode } = require("../../scripts/mine");
const { predictPadToken, brandedTokenSalt, tokenInitCode } = require("../helpers/brand");

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

    // MockStock as the quote. [H-2] the platform's registry is pinned on the factory and the curb adapter is
    // DERIVED from (stock, that registry) — a launcher no longer supplies one.
    const stockReg = await (await ethers.getContractFactory("MockStockRegistry")).deploy();
    const stock = await (await ethers.getContractFactory("MockStock")).connect(deployer).deploy(await stockReg.getAddress(), 10n ** 27n);
    await stockReg.setRegistered(await stock.getAddress(), true); // [H-2] the registry attests the stock
    const stockAddr = (await stock.getAddress()).toLowerCase();

    const fhd = await (await ethers.getContractFactory("FeeHookDeployer")).deploy(await dep.getAddress());
    const factory = await (await ethers.getContractFactory("StockPadFactory")).deploy(
      POOL_MANAGER, POSITION_MANAGER, PERMIT2, await dep.getAddress(), await reg.getAddress(),
      await lockVault.getAddress(), await stockReg.getAddress(), await fhd.getAddress()
    );
    await lockVault.setFactory(await factory.getAddress());

    const cfg = {
      name: "Robin NVDA", symbol: "rNVDA", decimals: 18,
      supply: 10n ** 24n, lpTokenAmount: 5n * 10n ** 23n, stockSeed: 10n ** 21n,
      sqrtPriceX96: SQRT_1_1, tickSpacing: 60, fee: 3000,
      buyTaxBps: 100, sellTaxBps: 100, sellFloorShareBps: 2000, guardWindow: 3600,
      stock: await stock.getAddress(), creator: creator.address,
      floorRecipient: ethers.ZeroAddress, stakingRecipient: ethers.ZeroAddress,
    };

    // mine tokenSalt so the token address sorts ABOVE the stock (quote = currency0) AND carries the `1ab5`
    // brand suffix — PadBrand.requireBrand reverts the launch otherwise, so this path must satisfy BOTH
    // constraints at once (the helper's extraOk predicate re-seeds until one address does).
    const depAddr = await dep.getAddress();
    const factoryAddr = await factory.getAddress();
    const TokenF = await ethers.getContractFactory("PadToken");
    const tokenSalt = await brandedTokenSalt(
      depAddr, factoryAddr, cfg, ethers.id("robin-nvda-1"), (a) => BigInt(a) > BigInt(stockAddr)
    );
    // cfg-bound salt: predict via the shared helper, never from the raw tokenSalt (see helpers/brand.js).
    const predictedToken = predictPadToken(depAddr, factoryAddr, cfg, tokenSalt, TokenF.bytecode);

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
    // [H-2] The curb adapter is DERIVED, never supplied — so assert the derivation itself rather than a
    // handle to one we made. It is CREATE2 over keccak256(abi.encode(stock, registry)) with the adapter's
    // init-code, through the same DeterministicDeployer, which is exactly what makes a launcher-authored
    // adapter (a freeze primitive) impossible to slip onto the curb path.
    const AdapterF = await ethers.getContractFactory("StockQuoteAdapter");
    const adapterInit = ethers.concat([
      AdapterF.bytecode,
      abi.encode(["address", "address"], [await stock.getAddress(), await stockReg.getAddress()]),
    ]);
    const expectedAdapter = ethers.getCreate2Address(
      await dep.getAddress(),
      ethers.keccak256(abi.encode(["address", "address"], [await stock.getAddress(), await stockReg.getAddress()])),
      ethers.keccak256(adapterInit)
    );
    expect(conf.guardAdapter).to.equal(expectedAdapter);
    expect(await ethers.provider.getCode(expectedAdapter)).to.not.equal("0x"); // really deployed there

    const posm = await ethers.getContractAt("IPositionManagerMinimal", POSITION_MANAGER);
    expect(await posm.ownerOf(lpTokenId)).to.equal(await lockVault.getAddress());
  });
});
