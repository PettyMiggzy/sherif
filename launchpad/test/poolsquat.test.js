const { expect } = require("chai");
const { ethers } = require("hardhat");
// [BRAND] a coin address must end in `1ab5`, so these squats have to target a MINED address like a real
// launch does. `mineFor` returns the salt and the address together, from the same miner the site and the
// bot run — the locally transcribed CREATE2 chain that used to live here was a fourth copy of it.
const { mineFor } = require("./helpers/brand");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const V3_POOL_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");

// [F-1 reopened] A SQUATTED UNISWAP POOL MUST NOT BRICK A MINED COIN ADDRESS.
//
// Anyone can call IUniswapV3Factory.createPool(token, WETH, 10000) and initialize() it at a price of their
// choosing. createPool type-checks nothing and needs no code at the token address, so this works on an address
// that does not exist yet. CurvePool used to revert BadPoolInit on any pre-existing price that was not its own
// start price. That was safe while the coin's address carried block entropy — a retry landed somewhere fresh.
// Once a creator can MINE their address (launchWithSalt) every retry returns to the same pool, so a squatter
// could brick a published contract address permanently for the cost of one initialize().
//
// CurvePool now repairs it in seed(): a swap against zero liquidity crosses no ticks and trades nothing, so it
// walks the price back to the start tick for free. A squatter who also FUNDS the pool is paid through with a
// bounded budget — see poolsquat-funded.test.js, which is the case this comment used to wave away as
// unreachable. It is very reachable: minting needs only the side of the range that is in range, so a WETH-only
// position costs one wei and never touches the codeless token address. Believing otherwise is what left the
// one-wei brick open.
//
// This runs against the REAL @uniswap/v3-core bytecode deployed locally, not the repo's mock and not a fork.
// The mock cannot mint the concentrated position CurvePool seeds, and a fork of the public node is far too slow
// (measured: both cases exceeded a 300s mocha timeout without finishing).

const START = 201600, WIDTH = 23000, MINGRAD = 22800;
const POOL_FEE = 10000;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

describe("[F-1] a squatted pool is repaired, not fatal", function () {
  this.timeout(180000);

  let dep, platform, dev, attacker, weth, v3, ltd, factory, factoryAddr;

  const NOTAX = () => ({ buyBps: 125, sellBps: 125, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address });

  before(async () => {
    [dep, platform, dev, attacker] = (await ethers.getSigners()).slice(-4);
    const at = async (n, ...a) => (await ethers.getContractFactory(n)).connect(dep).deploy(...a).then((c) => c.getAddress());
    weth = await at("MockWETH9");
    // the real thing, not the mock — the repair depends on real v3 swap behaviour at zero liquidity
    v3 = await new ethers.ContractFactory(V3_FACTORY_ART.abi, V3_FACTORY_ART.bytecode, dep).deploy().then((c) => c.getAddress());
    ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    const router = await at("PadRouter", weth, dep.address);
    factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd, ethers.ZeroAddress, START, WIDTH, MINGRAD
    );
    factoryAddr = await factory.getAddress();
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(factoryAddr)).wait();
  });

  const launched = (rc) => rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "Launched");

  it("an EMPTY squatted pool is walked back to the start price and the launch succeeds", async () => {
    const { salt, addr: token } = await mineFor(
      factory, dev.address, { name: "Robin Meme", symbol: "MEME" }, 0n, "mined-victim");

    // ── the squat: create + initialize the victim's pool before the coin exists ──
    expect(await ethers.provider.getCode(token)).to.equal("0x");
    const v3c = new ethers.Contract(v3, V3_FACTORY_ART.abi, attacker);
    await (await v3c.createPool(token, weth, POOL_FEE)).wait();
    const poolAddr = await v3c.getPool(token, weth, POOL_FEE);
    const pool = new ethers.Contract(poolAddr, V3_POOL_ART.abi, attacker);
    const hostile = 123456789012345678901n; // any price that is not ours
    await (await pool.initialize(hostile)).wait();
    expect((await pool.slot0())[0]).to.equal(hostile);
    expect(await pool.liquidity()).to.equal(0n);

    // ── the launch must still land, on the mined address, at OUR price ──
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "Robin Meme", symbol: "MEME", dev: dev.address, tax: NOTAX() }, salt
    )).wait();
    const ev = launched(rc);
    expect(ev.args.token).to.equal(token);   // the mined address, not a fresh one
    expect(ev.args.pool).to.equal(poolAddr); // the squatter's pool, repaired in place

    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const after = (await pool.slot0())[0];
    expect(after).to.not.equal(hostile);
    // Landed exactly on the curve's OWN start tick — not merely "somewhere other than hostile". This is the
    // assertion that matters: a repair that stopped short would seed the whole coin at the wrong price.
    expect((await pool.slot0())[1]).to.equal(await curve.startTick());
    expect(await curve.seeded()).to.equal(true);

    // the repair is announced, so it is visible on-chain that this coin was squatted
    const repaired = rc.logs.some((l) => { try { return curve.interface.parseLog(l).name === "PoolPriceRepaired"; } catch { return false; } });
    expect(repaired).to.equal(true);

    const TOK = await ethers.getContractAt("LaunchToken", token);
    expect(await TOK.tradingEnabled()).to.equal(true);
    expect(await TOK.totalSupply()).to.equal(SUPPLY);
  });

  it("an unsquatted launch emits no repair — the path does not fire spuriously", async () => {
    const { salt, addr: token } = await mineFor(
      factory, dev.address, { name: "Robin Two", symbol: "TWO" }, 0n, "mined-clean");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "Robin Two", symbol: "TWO", dev: dev.address, tax: NOTAX() }, salt
    )).wait();
    const ev = launched(rc);
    expect(ev.args.token).to.equal(token);

    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const repaired = rc.logs.some((l) => { try { return curve.interface.parseLog(l).name === "PoolPriceRepaired"; } catch { return false; } });
    expect(repaired).to.equal(false); // nothing to repair, so nothing was swapped
    expect((await new ethers.Contract(ev.args.pool, V3_POOL_ART.abi, dep).slot0())[1]).to.equal(await curve.startTick());
  });
});
