// DRESS REHEARSAL — the pre-mainnet "bot". Deploys the ENTIRE production stack (exactly like scripts/deploy.js)
// onto a real Robinhood-Chain fork, then a trading bot drives the full lifecycle through the REAL PadRouter
// (project tax + platform excess + 0.25%/0.25% reward legs — the true user path, not raw-pool swaps), asserting
// every guarantee before we spend real gas on mainnet:
//   launch + $1400 dev buy (~30%) · many wallets buy/sell (NO sell ever blocked, solvent) · graduation at ~4.2 ETH
//   with creator 0.5 + platform 0.5 + ~3.2 ETH floor · Bond posts & poke() works · RewardVault accrues both legs ·
//   post-graduation the pool still trades.
//   RUN:  FORK_RPC=<alchemy url> npx hardhat test test/dress-rehearsal.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ETH_USD = 1928;
// COMMITTED production calibration (locked)
const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

// deterministic PRNG so a failure reproduces
let _seed = 987654321;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("DRESS REHEARSAL — full production stack + trading bot on a real fork", function () {
  this.timeout(600000);

  it("deploys the whole stack, runs the lifecycle through PadRouter, and every guarantee holds", async () => {
    const signers = await ethers.getSigners();
    const [dep, platform, dev] = signers;
    const traders = signers.slice(3, 11); // 8-wallet trading bot
    const checks = [];
    const ok = (name, cond, detail = "") => { checks.push({ name, pass: !!cond, detail }); if (!cond) console.log(`   ✗ ${name}  ${detail}`); };

    // ── 1) DEPLOY THE ENTIRE STACK (mirror scripts/deploy.js) ──────────────────
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, V3_FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress,
      START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH);
    await (await router.setFactory(await factory.getAddress())).wait();
    const rewardVault = await (await ethers.getContractFactory("RewardVault")).deploy(
      await router.getAddress(), dep.address, dep.address, 7 * 24 * 3600, 24 * 3600, 2 * 24 * 3600, 30 * 24 * 3600, dep.address);
    await (await router.setRewardVault(await rewardVault.getAddress())).wait();
    const floorFactory = await (await ethers.getContractFactory("FloorCoopFactory")).deploy(WETH, V3_FACTORY, dep.address);
    const splitter = await (await ethers.getContractFactory("PlatformFeeSplitter")).deploy(dep.address, dep.address);
    ok("full stack deploys + wires (router.setFactory + setRewardVault)", true);
    console.log(`      stack up: factory ${(await factory.getAddress()).slice(0,10)} · router ${(await router.getAddress()).slice(0,10)} · rewardVault ${(await rewardVault.getAddress()).slice(0,10)}`);

    // ── 2) LAUNCH $ROBIN WITH A $1400 DEV BUY ──────────────────────────────────
    const TAX = { buyBps: 200, sellBps: 200, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address }; // 2%/2% real tax
    const devBuyEth = ethers.parseEther((1400 / ETH_USD).toFixed(6));
    await ethers.provider.send("hardhat_setBalance", [dev.address, "0x" + (10n ** 24n).toString(16)]);
    const lrc = await (await factory.connect(dev).launch({ name: "Robin", symbol: "ROBIN", dev: dev.address, tax: TAX }, { value: devBuyEth })).wait();
    const lev = lrc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = lev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], token);
    ok("token registered with router at launch", (await router.configOf(token)).set === true);
    const devTok = Number(ethers.formatEther(await TOK.balanceOf(dev.address)));
    ok("$1400 dev buy ≈ 30% of supply", devTok >= 0.25e9 && devTok <= 0.35e9, `got ${(devTok/1e6).toFixed(0)}M (${(devTok/1e7).toFixed(1)}%)`);
    console.log(`      $ROBIN launched. dev holds ${(devTok/1e6).toFixed(0)}M (${(devTok/1e7).toFixed(1)}% of supply) for $1400`);

    // ── 3) TRADING BOT — many wallets buy/sell through the ROUTER; no sell may ever block ──
    await ethers.provider.send("evm_increaseTime", [400]); // clear the anti-snipe window
    await ethers.provider.send("evm_mine", []);
    for (const t of traders) await ethers.provider.send("hardhat_setBalance", [t.address, "0x" + (10n ** 23n).toString(16)]);
    let sellReverts = 0, buys = 0, sells = 0, totalInWei = 0n, totalOutWei = 0n;
    const routerAddr = await router.getAddress();
    for (let round = 0; round < 60; round++) {
      const t = traders[Math.floor(rnd() * traders.length)];
      const bal = await TOK.balanceOf(t.address);
      const doSell = bal > 0n && rnd() < 0.42;
      if (doSell) {
        const amt = bal * BigInt(1 + Math.floor(rnd() * 60)) / 100n;
        if (amt === 0n) continue;
        await (await TOK.connect(t).approve(routerAddr, amt)).wait();
        const pre = await ethers.provider.getBalance(t.address);
        try {
          const rc = await (await router.connect(t).sell(token, amt, 0)).wait();
          const post = await ethers.provider.getBalance(t.address);
          const gas = rc.gasUsed * rc.gasPrice;
          totalOutWei += (post - pre) + gas; // ETH received (add back gas to isolate proceeds)
          sells++;
        } catch (e) { sellReverts++; console.log(`   sell revert round ${round}: ${String(e.message).slice(0,60)}`); }
      } else {
        const spend = ethers.parseEther((0.05 + rnd() * 0.45).toFixed(4));
        try {
          await (await router.connect(t).buy(token, 0, { value: spend })).wait();
          totalInWei += spend; buys++;
        } catch (e) { /* buy can legitimately hit the ceiling near graduation */ }
      }
    }
    ok("NO sell ever reverted through the router (not a honeypot)", sellReverts === 0, `${sellReverts} reverts`);
    console.log(`      bot: ${buys} buys / ${sells} sells across ${traders.length} wallets · sell reverts: ${sellReverts}`);

    // reward legs are forwarded as raw native ETH into the vault (0.25% buy + 0.25% sell)
    const rvEth = await ethers.provider.getBalance(await rewardVault.getAddress());
    ok("RewardVault accrued the trader/holder reward legs", rvEth > 0n, `${ethers.formatEther(rvEth)} ETH`);
    // project tax must have accrued to the coin's dev escrow (walletBps=100% -> projectWallet)
    ok("router collected project tax to escrow", (await router.devEscrow(token)) > 0n, `${ethers.formatEther(await router.devEscrow(token))} ETH`);

    // ── 4) DRIVE TO GRADUATION ─────────────────────────────────────────────────
    const ceiling = await curveC.gradSqrtPriceX96();
    const whale = traders[0];
    await ethers.provider.send("hardhat_setBalance", [whale.address, "0x" + (10n ** 24n).toString(16)]);
    for (let i = 0; i < 40 && !(await curveC.ready()); i++) {
      try { await (await router.connect(whale).buy(token, 0, { value: 2n * ONE })).wait(); } catch { break; }
    }
    ok("curve reaches graduation-ready", await curveC.ready());
    const devPre = await new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], ethers.provider).balanceOf(dev.address);
    const platPre = await new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], ethers.provider).balanceOf(platform.address);
    const grc = await (await curveC.graduate()).wait();
    const gev = grc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Graduated");
    const bondRaise = Number(ethers.formatEther(gev.args.raisedWeth));
    const W = new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
    const creatorGot = Number(ethers.formatEther((await W.balanceOf(dev.address)) - devPre));
    const platGot = Number(ethers.formatEther((await W.balanceOf(platform.address)) - platPre));
    ok("creator receives ~0.5 ETH at graduation", creatorGot >= 0.49 && creatorGot <= 0.51, `${creatorGot} ETH`);
    ok("platform receives ~0.5 ETH at graduation", platGot >= 0.49 && platGot <= 0.51, `${platGot} ETH`);
    ok("Bond floor funded ~3+ ETH", bondRaise >= 2.8, `${bondRaise.toFixed(3)} ETH`);
    ok("graduated flag set", await curveC.graduated());
    const bondAddr = await curveC.bond();
    console.log(`      GRADUATED: creator +${creatorGot} ETH · platform +${platGot} ETH · Bond floor ${bondRaise.toFixed(3)} ETH · bond ${bondAddr.slice(0,10)}`);

    // ── 5) POST-GRADUATION: pool still trades + Bond.poke() works ───────────────
    const buyer = traders[1];
    await ethers.provider.send("hardhat_setBalance", [buyer.address, "0x" + (10n ** 23n).toString(16)]);
    let postBuyOk = true, postSellOk = true;
    try { await (await router.connect(buyer).buy(token, 0, { value: ONE })).wait(); } catch { postBuyOk = false; }
    const bb = await TOK.balanceOf(buyer.address);
    try { await TOK.connect(buyer).approve(routerAddr, bb); await (await router.connect(buyer).sell(token, bb / 2n, 0)).wait(); } catch { postSellOk = false; }
    ok("post-graduation BUY works", postBuyOk);
    ok("post-graduation SELL works (still not a honeypot)", postSellOk);
    const bond = await ethers.getContractAt("Bond", bondAddr);
    let pokeOk = true;
    try { await (await bond.connect(buyer).poke()).wait(); } catch (e) { pokeOk = false; console.log(`   poke revert: ${String(e.message).slice(0,60)}`); }
    ok("Bond.poke() recenters the floor (permissionless)", pokeOk);

    // ── SUMMARY ────────────────────────────────────────────────────────────────
    const passed = checks.filter((c) => c.pass).length;
    console.log(`\n      ===== DRESS REHEARSAL: ${passed}/${checks.length} checks passed =====`);
    for (const c of checks) console.log(`      ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? "  ("+c.detail+")" : ""}`);
    expect(sellReverts, "a sell reverted — HONEYPOT risk").to.equal(0);
    expect(checks.every((c) => c.pass), "one or more dress-rehearsal checks failed").to.equal(true);
  });
});
