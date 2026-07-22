// Research tracer: buy the curve up in steps and print the REAL (ETH raised, tokens sold, FDV, circ-mcap)
// at each step, for the NEW calibration, so we can see exactly where any given mcap falls.
//   npx hardhat test test/trace-curve.test.js
const { ethers } = require("hardhat");
const { expect } = require("chai");

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;
const ETH_USD = 1920;
const TOTAL = 1_000_000_000; // 1B whole tokens

// param sets to trace
const SETS = [
  { name: "A: $1500 start -> $34k grad", smag: 209800, cw: 31400, mgw: 31200 },
  { name: "B: $2150 start -> $34k grad", smag: 206200, cw: 27800, mgw: 27600 },
];

function priceFDV(sqrtP, tokenIsToken0) {
  // wethPerToken (ETH per 1 token)
  const sp = Number(sqrtP) / 2 ** 96;
  const p10 = sp * sp; // token1 per token0
  const wethPerToken = tokenIsToken0 ? p10 : 1 / p10; // token0=token -> price is weth/token already
  const mcapEth = wethPerToken * TOTAL;
  return { wethPerToken, mcapEth, mcapUsd: mcapEth * ETH_USD };
}

describe("Curve tracer — real FDV vs ETH raised, step by step", function () {
  this.timeout(180000);
  for (const S of SETS) {
    it(`traces ${S.name}`, async () => {
      const [dep, platform, dev, buyer] = await ethers.getSigners();
      const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
      const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
      const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
      const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
      const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
        WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
        await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
        S.smag, S.cw, S.mgw
      );
      await (await router.setFactory(await factory.getAddress())).wait();

      const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
      const rc = await (await factory.launch({ name: "Trace", symbol: "TRC", dev: dev.address, tax: NOTAX })).wait();
      const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "Launched");
      const { token, curve, pool: poolAddr } = ev.args;
      const curveC = await ethers.getContractAt("CurvePool", curve);
      const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
      const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], token);
      const tokenIsToken0 = await curveC.tokenIsToken0();

      const poolTok0 = Number(ethers.formatEther(await TOK.balanceOf(poolAddr))); // 750M curve tokens live as pool liquidity
      const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
      const wethW = await ethers.getContractAt([
        "function deposit() payable", "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ], WETH);
      await ethers.provider.send("hardhat_setBalance", [buyer.address, "0x" + (10n ** 25n).toString(16)]);
      await (await wethW.connect(buyer).deposit({ value: 200n * ONE })).wait();
      await (await wethW.connect(buyer).approve(await probe.getAddress(), 1n << 250n)).wait();
      await ethers.provider.send("evm_increaseTime", [400]);
      await ethers.provider.send("evm_mine", []);

      // startFDV
      let s0 = await pool.slot0();
      const start = priceFDV(s0.sqrtPriceX96, tokenIsToken0);
      console.log(`\n      ===== ${S.name}  (${S.smag}/${S.cw}/${S.mgw}) =====`);
      console.log(`      START FDV: $${start.mcapUsd.toFixed(0)}  (${start.mcapEth.toFixed(3)} ETH)   curve holds ${(poolTok0/1e6).toFixed(0)}M tokens as liquidity`);
      console.log(`      step   ETHin(cum)   tokensSold   %ofCurve   FDV(USD)     circMcap(USD)   ready?`);

      const ceiling = await curveC.gradSqrtPriceX96(); // never let a buy push past the ceiling
      const STEP = ethers.parseEther("0.25");
      let cumIn = 0n;
      const buyerWeth0 = await wethW.balanceOf(buyer.address);
      for (let i = 0; i < 40; i++) {
        try {
          await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, STEP, ceiling)).wait();
        } catch (e) { console.log(`      (buy stopped at step ${i}: ${String(e.message).slice(0,50)})`); break; }
        cumIn = buyerWeth0 - (await wethW.balanceOf(buyer.address));
        const sold = poolTok0 - Number(ethers.formatEther(await TOK.balanceOf(poolAddr)));
        const s = await pool.slot0();
        const f = priceFDV(s.sqrtPriceX96, tokenIsToken0);
        const circ = f.wethPerToken * sold * ETH_USD; // circulating-supply mcap (price × tokens actually sold)
        const ready = await curveC.ready();
        console.log(`      ${String(i).padStart(3)}  ${Number(ethers.formatEther(cumIn)).toFixed(3).padStart(9)}   ${(sold/1e6).toFixed(1).padStart(7)}M   ${(sold/poolTok0*100).toFixed(0).padStart(5)}%    $${f.mcapUsd.toFixed(0).padStart(7)}     $${circ.toFixed(0).padStart(7)}     ${ready}`);
        if (ready) { console.log(`      >>> GRADUATABLE at ${Number(ethers.formatEther(cumIn)).toFixed(3)} ETH raised, FDV $${f.mcapUsd.toFixed(0)}, ${(sold/1e6).toFixed(0)}M sold (${(sold/poolTok0*100).toFixed(0)}% of the 750M curve)`); break; }
      }
      expect(true).to.equal(true);
    });
  }
});
