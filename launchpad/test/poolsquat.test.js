const { expect } = require("chai");
const { ethers } = require("hardhat");
// [BRAND] a coin address must end in `1ab5`, so these squats have to target a MINED address like a real
// launch does. `mineFor` returns the salt and the address together, from the same miner the site and the
// bot run — the locally transcribed CREATE2 chain that used to live here was a fourth copy of it.
const { mineFor } = require("./helpers/brand");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const V3_POOL_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");

// Canonical Uniswap TickMath.getSqrtRatioAtTick, reimplemented in JS (matches PoolMath.getSqrtRatioAtTick) so
// the "landed on OUR tick" assertions below can check the PoolPriceRepaired event's own price argument without
// a contract round-trip. Same implementation as poolsquat-funded.test.js.
function getSqrtRatioAtTick(tick) {
  const abs = BigInt(tick < 0 ? -tick : tick);
  let ratio = (abs & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const muls = [
    [0x2n,0xfff97272373d413259a46990580e213an],[0x4n,0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n,0xffe5caca7e10e4e61c3624eaa0941cd0n],[0x10n,0xffcb9843d60f6159c9db58835c926644n],
    [0x20n,0xff973b41fa98c081472e6896dfb254c0n],[0x40n,0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n,0xfe5dee046a99a2a811c461f1969c3053n],[0x100n,0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n,0xf987a7253ac413176f2b074cf7815e54n],[0x400n,0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n,0xe7159475a2c29b7443b29c7fa6e889d9n],[0x1000n,0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n,0xa9f746462d870fdf8a65dc1f90e061e5n],[0x4000n,0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n,0x31be135f97d08fd981231505542fcfa6n],[0x10000n,0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n,0x5d6af8dedb81196699c329225ee604n],[0x40000n,0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n,0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, m] of muls) if ((abs & bit) !== 0n) ratio = (ratio * m) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

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
      { name: "Robin Meme", symbol: "MEME", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 }, salt,
      { value: ethers.parseEther("0.001") }
    )).wait();
    const ev = launched(rc);
    expect(ev.args.token).to.equal(token);   // the mined address, not a fresh one
    expect(ev.args.pool).to.equal(poolAddr); // the squatter's pool, repaired in place

    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const after = (await pool.slot0())[0];
    expect(after).to.not.equal(hostile);
    expect(await curve.seeded()).to.equal(true);

    // the repair is announced, so it is visible on-chain that this coin was squatted — and REPAIR ITSELF (inside
    // seed(), before the mandatory creation-fee buy that follows later in the same launch tx) landed EXACTLY on
    // the curve's OWN start tick, not merely "somewhere other than hostile". This is the assertion that matters:
    // a repair that stopped short would seed the whole coin at the wrong price. Checked via the event's own
    // price argument rather than post-tx slot0, because slot0 now also reflects the creation-fee buy's small,
    // separate, intentional forward nudge off that tick.
    const repairedEv = rc.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "PoolPriceRepaired");
    expect(repairedEv, "PoolPriceRepaired must fire").to.not.equal(undefined);
    expect(repairedEv.args.startSqrtPriceX96).to.equal(getSqrtRatioAtTick(await curve.startTick()));

    const TOK = await ethers.getContractAt("LaunchToken", token);
    expect(await TOK.tradingEnabled()).to.equal(true);
    expect(await TOK.totalSupply()).to.equal(SUPPLY);
  });

  it("an unsquatted launch emits no repair — the path does not fire spuriously", async () => {
    const { salt, addr: token } = await mineFor(
      factory, dev.address, { name: "Robin Two", symbol: "TWO" }, 0n, "mined-clean");
    const rc = await (await factory.connect(dev).launchWithSalt(
      { name: "Robin Two", symbol: "TWO", dev: dev.address, tax: NOTAX(), poolFee: 0, auctionDays: 0 }, salt,
      { value: ethers.parseEther("0.001") }
    )).wait();
    const ev = launched(rc);
    expect(ev.args.token).to.equal(token);

    const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
    const repaired = rc.logs.some((l) => { try { return curve.interface.parseLog(l).name === "PoolPriceRepaired"; } catch { return false; } });
    expect(repaired).to.equal(false); // nothing to repair, so nothing was swapped
    expect(await curve.seeded()).to.equal(true);
  });
});
