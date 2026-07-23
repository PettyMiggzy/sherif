const { expect } = require("chai");
const { ethers } = require("hardhat");

// Adversarial FloorCoop (locked-LP staking vault) battery against REAL Uniswap v3 on the Robinhood Chain fork.
// Bootstraps a graduated coin (so there is a live, liquid pool), attaches a FloorCoop, then runs many random
// rounds of deposit / withdraw(early+late) / compound / claim / sweep / price-shove and asserts the vault's
// solvency + accounting invariants after EVERY op. Crank it up:
//   SIMS=300 FORK_RPC=<rpc> npx hardhat test test/fork/floorcoop-sim.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const SIMS = Number(process.env.SIMS || 40); // rounds of random ops
const suite = process.env.FORK_RPC ? describe : describe.skip;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const LOCK_DAYS = [30, 60, 90, 365, 0];

// FloorCoop custom-error selectors → name, so a revert is never a black box.
const FC_ERRORS = ["NoPool", "NotPool", "Manipulated", "Zero", "Locked", "TooMuch", "Slippage", "PayFail", "MinDeposit", "BadTerm", "StaleTwap", "DustExit"];
const SELECTORS = Object.fromEntries(FC_ERRORS.map((n) => [ethers.id(`${n}()`).slice(0, 10), n]));
// Guard-class reverts are the vault CORRECTLY refusing to price against a manipulated/cold oracle — a settle+retry
// clears them. Anything else (PayFail, arithmetic panic, a real Locked after unlock) means funds are genuinely stuck.
const GUARD_CLASS = new Set(["Manipulated", "StaleTwap", "Slippage"]);
// Decode a revert to its FloorCoop error name (via decoded revert, raw selector, or message), else a trimmed message.
function revertName(e) {
  if (e && e.revert && e.revert.name) return e.revert.name;
  const data = e && (e.data || (e.info && e.info.error && e.info.error.data));
  if (typeof data === "string" && SELECTORS[data.slice(0, 10)]) return SELECTORS[data.slice(0, 10)];
  const m = (e && e.message) || "";
  const hit = FC_ERRORS.find((n) => m.includes(n));
  if (hit) return hit;
  if (/panic|arithmetic|overflow|underflow|0x11/i.test(m)) return "Panic(arithmetic)";
  return m.slice(0, 160) || "unknown";
}

suite("FloorCoop battery — random deposit/withdraw/compound/claim/shove; solvency holds every op", function () {
  // Live-fork round-trips per op → scale the mocha ceiling with SIMS so a big battery can't die on the timeout.
  this.timeout(Math.max(60, SIMS * 2) * 60 * 1000);

  it(`runs ${SIMS} randomized adversarial rounds and never loses track of funds`, async () => {
    const signers = await ethers.getSigners();
    const [dep, platform, dev, buyer, treasury, u1, u2, u3] = signers;
    const users = [u1, u2, u3];

    // ── bootstrap a graduated coin → real liquid pool ──
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), ethers.ZeroAddress, 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function withdraw(uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await ethers.provider.send("hardhat_setBalance", [buyer.address, "0x" + (10n ** 24n).toString(16)]); // 1,000,000 ETH
    await (await wethW.connect(buyer).deposit({ value: 400n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 1n << 250n)).wait();
    const topUpWeth = async () => { if ((await wethW.balanceOf(buyer.address)) < 20n * ONE) await (await wethW.connect(buyer).deposit({ value: 400n * ONE })).wait(); };

    const rc = await (await factory.launch({ name: "FC", symbol: "FC", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const TOK = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], token);
    await ethers.provider.send("evm_increaseTime", [400]); await ethers.provider.send("evm_mine", []);
    // buy all the way to the ceiling (the ONLY graduation point), then graduate → a live, liquid pool
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, await curveC.gradSqrtPriceX96())).wait();
    await (await curveC.graduate()).wait();
    expect(await pool.liquidity()).to.be.greaterThan(0n);

    // ── warm the oracle so FloorCoop's adaptive TWAP (>=30s of history) is satisfiable ──
    for (let w = 0; w < 3; w++) {
      const t = (await pool.slot0()).tick;
      // tiny nudge swaps to write observations, spaced in time
      const lim = BigInt((await pool.slot0()).sqrtPriceX96) - 1n;
      try { await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, ONE / 100n, lim)).wait(); } catch {}
      await ethers.provider.send("evm_increaseTime", [40]); await ethers.provider.send("evm_mine", []);
    }

    // ── attach a FloorCoop ──
    const fcFactory = await (await ethers.getContractFactory("FloorCoopFactory")).deploy(WETH, FACTORY, treasury.address);
    await (await fcFactory.createCoop(token)).wait();
    const coopAddr = await fcFactory.coopOf(token);
    const coop = await ethers.getContractAt("FloorCoop", coopAddr);
    const tokC = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], token);

    // fund users with ETH (they already have hardhat ETH). Track value in/out per user.
    const depositedEth = {}; // user => total ETH deposited
    const withdrawnW = {}, withdrawnT = {}, claimedW = {}, claimedT = {};
    for (const u of users) { depositedEth[u.address] = 0n; withdrawnW[u.address] = 0n; withdrawnT[u.address] = 0n; }

    const shove = async (up) => {
      // move spot by swapping; `up` buys token (price up), else sells token-side via WETH the other way
      await topUpWeth();
      const s = BigInt((await pool.slot0()).sqrtPriceX96);
      const lim = up ? (s * 1020n) / 1000n : (s * 980n) / 1000n;
      try { await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 3n * ONE, lim)).wait(); } catch {}
    };

    async function checkSolvency(tag) {
      // core custody invariants — if any of these break, the vault has lost track of funds
      const [ts, wbal, tbal, frW, frT, pW, pT] = await Promise.all([
        coop.totalShares(),
        wethW.balanceOf(coopAddr), tokC.balanceOf(coopAddr),
        coop.feeReserveWeth(), coop.feeReserveToken(), coop.protocolWeth(), coop.protocolToken(),
      ]);
      // INV-1: reserves are always backed by real balance (this is exactly what _looseX subtracts; underflow => brick)
      expect(wbal, `${tag}: WETH balance backs reserves`).to.be.greaterThanOrEqual(frW + pW);
      expect(tbal, `${tag}: token balance backs reserves`).to.be.greaterThanOrEqual(frT + pT);
      // INV-2: shares == Σ user shares (no phantom shares)
      let sumSh = 0n;
      for (const u of users) sumSh += await coop.shares(u.address);
      expect(sumSh, `${tag}: totalShares == Σ shares`).to.equal(ts);
      // INV-3: totalNav view never reverts (oracle live) and is finite
      const nav = await coop.totalNav();
      expect(nav, `${tag}: nav >= 0`).to.be.greaterThanOrEqual(0n);
      // INV-4: pending never reverts / underflows for any user
      for (const u of users) { const p = await coop.pending(u.address); expect(p[0] >= 0n && p[1] >= 0n, `${tag}: pending ok`).to.equal(true); }
    }

    await checkSolvency("init");
    const rand = rng(0xF100C0);
    let deposits = 0, withdraws = 0, earlyWithdraws = 0, compounds = 0, claims = 0, sweeps = 0, guarded = 0, protoStart = await coop.protocolWeth();

    for (let i = 0; i < SIMS; i++) {
      const u = users[Math.floor(rand() * users.length)];
      const act = rand();
      try {
        if (act < 0.42) {
          // DEPOSIT — random amount + lock term. Protocol must get exactly 10% of msg.value.
          const amt = (ONE / 10n) + BigInt(Math.floor(rand() * 3e18)); // 0.1 .. ~3.1 ETH
          const lock = LOCK_DAYS[Math.floor(rand() * LOCK_DAYS.length)];
          const pBefore = await coop.protocolWeth();
          const rcp = await (await coop.connect(u).deposit(lock, 0, { value: amt })).wait();
          const pGain = (await coop.protocolWeth()) - pBefore;
          // deposit() harvests LP fees in the SAME tx (before the open fee), routing 5% (FEE_CUT_BPS) of the
          // harvested WETH to protocol too. So protocolΔ = 10% open fee + 5%·harvestedWeth — not just the open
          // fee. Read the harvest from this tx's own Harvested event so the check is exact, not approximate.
          let harvestCut = 0n;
          for (const l of rcp.logs) { let pl; try { pl = coop.interface.parseLog(l); } catch { continue; } if (pl && pl.name === "Harvested") harvestCut += (pl.args[0] * 500n) / 10000n; }
          expect(pGain, `#${i} protocol gain = 10% open fee + 5% harvest cut`).to.equal(amt / 10n + harvestCut);
          depositedEth[u.address] += amt;
          deposits++;
        } else if (act < 0.62) {
          // WITHDRAW — random fraction of the user's shares (early => tiered penalty to protocol)
          const sh = await coop.shares(u.address);
          if (sh === 0n) continue;
          const frac = 1n + BigInt(Math.floor(rand() * 100));
          const amt = (sh * frac) / 100n; if (amt === 0n) continue;
          const posBefore = await coop.pos(u.address);
          const early = BigInt((await ethers.provider.getBlock("latest")).timestamp) < posBefore.lockUntil;
          const pBefore = await coop.protocolWeth();
          const wB = await wethW.balanceOf(u.address), tB = await tokC.balanceOf(u.address);
          await (await coop.connect(u).withdraw(amt, 0, 0)).wait();
          withdrawnW[u.address] += (await wethW.balanceOf(u.address)) - wB;
          withdrawnT[u.address] += (await tokC.balanceOf(u.address)) - tB;
          if (early) { expect(await coop.protocolWeth(), `#${i} early penalty grows protocol`).to.be.greaterThanOrEqual(pBefore); earlyWithdraws++; }
          withdraws++;
        } else if (act < 0.74) {
          await (await coop.connect(u).compound()).wait(); compounds++;
        } else if (act < 0.86) {
          await (await coop.connect(u).claim()).wait(); claims++;
        } else if (act < 0.93) {
          await (await coop.sweepProtocol()).wait(); sweeps++;
        } else {
          await shove(rand() < 0.5); // move price to poke the TWAP guard
        }
      } catch (e) {
        // Guarded reverts are EXPECTED and correct (Manipulated / Slippage / Locked / StaleTwap / TooMuch / etc.).
        const name = revertName(e);
        if (["Manipulated", "Slippage", "Locked", "StaleTwap", "TooMuch", "Zero", "MinDeposit", "BadTerm", "DustExit"].includes(name) || /range/.test(e.message || "")) { guarded++; }
        else {
          const opName = act < 0.42 ? "deposit" : act < 0.62 ? "withdraw" : act < 0.74 ? "compound" : act < 0.86 ? "claim" : act < 0.93 ? "sweep" : "shove";
          console.log(`\n=== UNEXPECTED REVERT at #${i} op=${opName} (act=${act.toFixed(4)}) decoded=${name} ===`);
          console.log("MESSAGE:", (e.message || "").slice(0, 1500));
          console.log("STACK:", (e.stack || "").slice(0, 2500));
          throw new Error(`#${i} unexpected revert on ${opName}: ${name}`);
        }
      }
      await checkSolvency(`#${i}`);
      // occasionally advance time so locks can expire and the oracle stays warm
      if (i % 5 === 0) { await ethers.provider.send("evm_increaseTime", [3600 * 24 * 20]); await ethers.provider.send("evm_mine", []); }
      if ((i + 1) % 25 === 0) console.log(`      …${i + 1}/${SIMS} rounds, solvency held (${deposits}d/${withdraws}w/${guarded}g)`);
    }

    // ── final unwind: everyone withdraws everything; vault must drain to ~dust ──
    // SETTLE first: a lingering `shove` can leave spot deviated from the last oracle observation, so the TWAP
    // guard (correctly) blocks withdrawal. Write a fresh observation AT the current spot, then let >1 window
    // elapse at rest so the TWAP converges to spot and the guard opens. This proves funds are RECOVERABLE.
    const settle = async () => {
      for (let s = 0; s < 3; s++) {
        const sp = BigInt((await pool.slot0()).sqrtPriceX96);
        try { await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, ONE / 1000n, sp + sp / 200000n)).wait(); } catch {}
        await ethers.provider.send("evm_increaseTime", [400]); await ethers.provider.send("evm_mine", []);
      }
    };
    await ethers.provider.send("evm_increaseTime", [3600 * 24 * 400]); await ethers.provider.send("evm_mine", []);
    await settle();
    await (await coop.connect(buyer).compound()).wait().catch(() => {});
    for (const u of users) {
      let sh = await coop.shares(u.address);
      if (sh > 0n) {
        const wB = await wethW.balanceOf(u.address), tB = await tokC.balanceOf(u.address);
        // retry across settles — a transient guard block must NOT permanently strand funds
        let lastReason = null;
        for (let attempt = 0; attempt < 4 && sh > 0n; attempt++) {
          try {
            await (await coop.connect(u).withdraw(sh, 0, 0)).wait();
            withdrawnW[u.address] += (await wethW.balanceOf(u.address)) - wB;
            withdrawnT[u.address] += (await tokC.balanceOf(u.address)) - tB;
            sh = 0n;
          } catch (e) {
            lastReason = revertName(e);
            // A NON-guard revert (PayFail, arithmetic panic, still-Locked) is a real liveness bug: settling can't
            // clear it, so fail immediately with the decoded cause instead of masking it behind 3 wasted retries.
            if (!GUARD_CLASS.has(lastReason)) {
              throw new Error(`FUNDS STRANDED (real): ${u.address} withdraw of ${sh} shares reverted with ${lastReason} — not a price-guard block, settling won't fix it`);
            }
            await settle(); // guard-class: price/oracle still converging — write obs + wait, then retry
          }
        }
        if (sh > 0n) {
          // Exhausted retries on a guard-class revert. This is the harness's oracle not having reconverged after the
          // 400-day jump, NOT a contract defect — but we surface the exact reason + share count so it's never guessed at.
          throw new Error(`FUNDS STRANDED (guard/${lastReason}): ${u.address} could not withdraw ${sh} shares after 4 settle+retry passes. Last block on the TWAP guard (${lastReason}); withdrawal opens once the oracle reconverges to spot.`);
        }
      }
      await (await coop.connect(u).claim()).wait().catch(() => {});
    }
    await checkSolvency("final");

    // INV-5 (no free money): each user's realized WETH out must be < their ETH in (they pay 10% + swap + often
    // a penalty; any token out is IL-side and valued separately). This catches a value-creation bug.
    for (const u of users) {
      if (depositedEth[u.address] > 0n) {
        expect(withdrawnW[u.address], `no-free-money ${u.address}`).to.be.lessThan(depositedEth[u.address]);
      }
    }
    // INV-6: after full unwind the vault holds no meaningful principal beyond reserves + dust
    const ts = await coop.totalShares();
    expect(ts, "shares near zero after unwind").to.be.lessThan(ONE / 1000n); // < 0.001 shares dust

    console.log(`      ${SIMS} rounds: ${deposits} deposits, ${withdraws} withdraws (${earlyWithdraws} early), ${compounds} compounds, ${claims} claims, ${sweeps} sweeps, ${guarded} guarded-reverts. Solvency held every op.`);
  });
});
