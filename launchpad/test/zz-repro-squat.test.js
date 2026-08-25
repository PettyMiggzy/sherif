const { expect } = require("chai");
const { ethers } = require("hardhat");
const V3F = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

const POOL_FEE = 10000;
const START = 201600, WIDTH = 35800, MINGRAD = 19800;

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

describe("REPRO: out-of-range WETH-only squat blocks the seed() repair", function () {
  this.timeout(300000);
  const NOTAX = (dev) => ({ buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev });

  async function predictToken(ltdAddr, factoryAddr, creator, tokenSalt, name, symbol, supply) {
    const inner = ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [creator, tokenSalt]));
    const outer = ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [factoryAddr, inner]));
    const guard = { deadSecs:0, phase1Secs:0, antiSnipeSecs:0, maxTxBps1:0, maxWalletBps1:0, maxTxBps2:0, maxWalletBps2:0, cooldownSecs:0 };
    const art = await ethers.getContractFactory("LaunchToken");
    const init = ethers.concat([art.bytecode, art.interface.encodeDeploy([name, symbol, supply, factoryAddr, guard])]);
    return ethers.getCreate2Address(ltdAddr, outer, ethers.keccak256(init));
  }

  it("a squatter funds the pool with WETH only, before the token exists, and the launch reverts", async () => {
    const [dep, platform, dev, attacker] = await ethers.getSigners();
    const v3 = await (new ethers.ContractFactory(V3F.abi, V3F.bytecode, dep)).deploy();
    await v3.waitForDeployment();
    const V3_FACTORY = await v3.getAddress();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const WETH = await weth.getAddress();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd  = await (await ethers.getContractFactory("BondDeployer")).deploy(9000, 15600);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, START, WIDTH, MINGRAD
    );
    await (await router.setFactory(await factory.getAddress())).wait();

    const LIQ = BigInt(process.env.LIQ || "1");
    const salt = ethers.id("mined-vanity-address");
    const SUPPLY = 1_000_000_000n * 10n ** 18n;
    const token = await predictToken(await ltd.getAddress(), await factory.getAddress(), dev.address, salt, "Robin Meme", "MEME", SUPPLY);
    expect(await ethers.provider.getCode(token)).to.equal("0x");   // no code at the mined address yet

    const tokenIsToken0 = token.toLowerCase() < WETH.toLowerCase();
    const startTick = tokenIsToken0 ? -START : START;

    // Pick the squat price and a blocking range that needs WETH ONLY at that price.
    //  WETH == token0  -> a token0-only position must be ENTIRELY ABOVE the current tick  -> squat below `want`
    //  WETH == token1  -> a token1-only position must be ENTIRELY BELOW the current tick  -> squat above `want`
    let hostileTick, lo, hi;
    if (!tokenIsToken0) {                 // WETH is token0
      hostileTick = startTick - 4000; lo = startTick - 2000; hi = startTick - 1800;
    } else {                              // WETH is token1
      hostileTick = startTick + 4000; hi = startTick + 2000; lo = startTick + 1800;
    }
    console.log({ token, WETH, tokenIsToken0, startTick, hostileTick, lo, hi });

    await (await v3.createPool(token, WETH, POOL_FEE)).wait();
    const poolAddr = await v3.getPool(token, WETH, POOL_FEE);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    await (await pool.connect(attacker).initialize(getSqrtRatioAtTick(hostileTick))).wait();

    // --- the funding step: does it need the token to have code? ---
    const atk = await (await ethers.getContractFactory("LiquidityAttacker")).connect(attacker).deploy();
    await (await weth.connect(attacker).deposit({ value: ethers.parseEther("1") })).wait();
    await (await weth.connect(attacker).approve(await atk.getAddress(), ethers.MaxUint256)).wait();
    if (!process.env.NOSQUATLIQ) {
      await (await atk.connect(attacker).mint(poolAddr, lo, hi, LIQ)).wait();
      console.log("MINT SUCCEEDED with no code at the token address:", await ethers.provider.getCode(token) === "0x");
      console.log("weth the squat cost (wei):", (ethers.parseEther("1") - await weth.balanceOf(attacker.address)).toString());
    } else { console.log("CONTROL: no blocking liquidity planted"); }
    console.log("pool.liquidity() as the constructor/seed will read it:", (await pool.liquidity()).toString());

    // --- the launch ---
    const params = { name: "Robin Meme", symbol: "MEME", dev: dev.address, tax: NOTAX(dev.address) };
    let err = null, rc = null;
    try { rc = await (await factory.connect(dev).launchWithSalt(params, salt)).wait(); }
    catch (e) { err = e; }
    console.log("LAUNCH RESULT:", err ? ("REVERTED: " + (err.shortMessage || err.message)) : "SUCCEEDED");
    if (rc) {
      const ev = rc.logs.map((l)=>{try{return factory.interface.parseLog(l);}catch{return null;}}).find(e=>e&&e.name==="Launched");
      console.log("launched token:", ev.args.token, "expected:", token, "match:", ev.args.token===token);
      const artD = await ethers.getContractFactory("LaunchToken");
      const innerD = ethers.keccak256(ethers.solidityPacked(["address","bytes32"],[dev.address, salt]));
      const outerD = ethers.keccak256(ethers.solidityPacked(["address","bytes32"],[await factory.getAddress(), innerD]));
      const gD = { deadSecs:0, phase1Secs:0, antiSnipeSecs:0, maxTxBps1:0, maxWalletBps1:0, maxTxBps2:0, maxWalletBps2:0, cooldownSecs:0 };
      const initD = ethers.concat([artD.bytecode, artD.interface.encodeDeploy(["Robin Meme","MEME",SUPPLY,await factory.getAddress(),gD])]);
      console.log("inner",innerD,"outer",outerD,"initHash",ethers.keccak256(initD));
      console.log("recompute:", ethers.getCreate2Address(await ltd.getAddress(), outerD, ethers.keccak256(initD)));
      console.log("ltd:", await ltd.getAddress(), "factory:", await factory.getAddress());
      console.log("token code len:", (await ethers.provider.getCode(ev.args.token)).length, " runtime match:", (await ethers.provider.getCode(ev.args.token)) === artD.interface ? "" : "");
      console.log("launched pool :", ev.args.pool, "squatted pool:", poolAddr, "match:", ev.args.pool===poolAddr);
      const curve = await ethers.getContractAt("CurvePool", ev.args.curve);
      console.log("PoolPriceRepaired emitted:", rc.logs.some(l=>{try{return curve.interface.parseLog(l).name==="PoolPriceRepaired";}catch{return false;}}));
    }
    console.log("slot0 after:", (await pool.slot0())[0].toString(), " want:", getSqrtRatioAtTick(startTick).toString());
    console.log("liquidity after:", (await pool.liquidity()).toString());


  });
});
