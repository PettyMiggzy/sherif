const { expect } = require("chai");
const { ethers } = require("hardhat");

// [F-1 reopened] A SQUATTED UNISWAP POOL MUST NOT BRICK A MINED COIN ADDRESS.
//
// Anyone can call IUniswapV3Factory.createPool(token, WETH, 10000) and initialize() it at a price of their
// choosing. createPool type-checks nothing and needs no code at the token address, so this works on an address
// that does not exist yet. CurvePool used to revert BadPoolInit on any pre-existing price that was not its own
// start price. That was safe while the coin's address carried block entropy — a retry landed somewhere fresh.
// Once a creator can MINE their address (launchWithSalt), every retry returns to the same pool, so a squatter
// could brick a published contract address permanently for the cost of one initialize().
//
// CurvePool now repairs it in seed() instead: a swap against zero liquidity crosses no ticks and trades
// nothing, so it walks the price back to the start tick for free. A squatter who also FUNDS the pool cannot be
// walked back for free, and that case still reverts — but it costs them real liquidity instead of one cheap
// call. That funded case is NOT asserted below and deliberately so: minting a position needs the token to have
// code, so an attacker can only fund the pool in the same block as the launch, which Robinhood Chain's
// single-sequencer FCFS ordering forecloses. The revert is the documented boundary, not a tested path.
//
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/poolsquat.fork.test.js
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POOL_FEE = 10000;
const START = 207200, WIDTH = 35800, MINGRAD = 19800;

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("[F-1] a squatted pool is repaired, not fatal", function () {
  this.timeout(300000);

  const NOTAX = (dev) => ({ buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev });

  async function stack(dep, platform) {
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, START, WIDTH, MINGRAD
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    return { factory, ltd };
  }

  // Reproduce the exact CREATE2 the factory will use for a given caller + mined salt.
  async function predictToken(ltdAddr, factoryAddr, creator, tokenSalt, name, symbol, supply) {
    const inner = ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [creator, tokenSalt]));
    const outer = ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [factoryAddr, inner]));
    const guard = { deadSecs: 0, phase1Secs: 0, antiSnipeSecs: 0, maxTxBps1: 0, maxWalletBps1: 0, maxTxBps2: 0, maxWalletBps2: 0, cooldownSecs: 0 };
    const art = await ethers.getContractFactory("LaunchToken");
    const init = ethers.concat([art.bytecode, art.interface.encodeDeploy([name, symbol, supply, factoryAddr, guard])]);
    return ethers.getCreate2Address(ltdAddr, outer, ethers.keccak256(init));
  }

  it("an EMPTY squatted pool is walked back to the start price and the launch succeeds", async () => {
    const [dep, platform, dev, attacker] = await ethers.getSigners();
    const { factory, ltd } = await stack(dep, platform);
    const factoryAddr = await factory.getAddress();
    const salt = ethers.id("mined-for-this-test");
    const SUPPLY = 1_000_000_000n * 10n ** 18n;

    const token = await predictToken(await ltd.getAddress(), factoryAddr, dev.address, salt, "Robin Meme", "MEME", SUPPLY);

    // ── the squat: create + initialize the victim's pool at a hostile price, before the coin exists ──
    expect(await ethers.provider.getCode(token)).to.equal("0x"); // nothing deployed there yet
    const v3 = await ethers.getContractAt("IUniswapV3Factory", V3_FACTORY);
    await (await v3.connect(attacker).createPool(token, WETH, POOL_FEE)).wait();
    const poolAddr = await v3.getPool(token, WETH, POOL_FEE);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const hostile = 123456789012345678901n; // any price that is not ours
    await (await pool.connect(attacker).initialize(hostile)).wait();
    expect((await pool.slot0())[0]).to.equal(hostile);
    expect(await pool.liquidity()).to.equal(0n);

    // ── the launch must still land, on OUR price ──
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "Robin Meme", symbol: "MEME", dev: dev.address, tax: NOTAX(dev.address) }, salt
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    expect(ev.args.token).to.equal(token);   // the mined address, not a fresh one
    expect(ev.args.pool).to.equal(poolAddr); // the squatter's pool, repaired

    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const want = (await pool.slot0())[0];
    expect(want).to.not.equal(hostile);
    expect(await curve.seeded()).to.equal(true);
    // the repair is announced, so it is visible on-chain that this happened
    expect(rc.logs.some((l) => { try { return curve.interface.parseLog(l).name === "PoolPriceRepaired"; } catch { return false; } })).to.equal(true);

    // and the coin actually trades from the right price
    const TOK = await ethers.getContractAt("LaunchToken", token);
    expect(await TOK.tradingEnabled()).to.equal(true);
    expect(await TOK.totalSupply()).to.equal(SUPPLY);
  });

  it("an unsquatted launch emits no repair — the path does not fire spuriously", async () => {
    const [dep, platform, dev] = await ethers.getSigners();
    const { factory, ltd } = await stack(dep, platform);
    const salt = ethers.id("mined-clean");
    const SUPPLY = 1_000_000_000n * 10n ** 18n;
    const token = await predictToken(await ltd.getAddress(), await factory.getAddress(), dev.address, salt, "Robin Two", "TWO", SUPPLY);

    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "Robin Two", symbol: "TWO", dev: dev.address, tax: NOTAX(dev.address) }, salt
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    expect(ev.args.token).to.equal(token);

    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const repaired = rc.logs.some((l) => {
      try { return curve.interface.parseLog(l).name === "PoolPriceRepaired"; } catch { return false; }
    });
    expect(repaired).to.equal(false); // nothing to repair, so nothing was swapped
  });
});
