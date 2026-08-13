// REGRESSION TEST for C-1 (see AUDITOR-HANDOFF.md). Proves the staking-reservoir capture is dead: the arm no
// longer opens a live zero-rate window, and a tail staker earns seconds-of-drip instead of the whole reservoir.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = (x) => ethers.parseEther(String(x));

describe("C-1 exploit, replayed against the patched contract", () => {
  async function pool() {
    const [owner, atk, honest] = await ethers.getSigners();
    const tok = await (await ethers.getContractFactory("TestERC20")).deploy(10n ** 30n);
    const st = await (await ethers.getContractFactory("RobinLockStaking"))
      .deploy(await tok.getAddress(), 30 * 86400, 30 * 86400);
    for (const w of [atk, honest]) {
      await tok.transfer(w.address, E(1000000));
      await tok.connect(w).approve(await st.getAddress(), ethers.MaxUint256);
    }
    await tok.approve(await st.getAddress(), ethers.MaxUint256);
    return { owner, atk, honest, tok, st };
  }

  it("the arm no longer arms: fund(2) + stake(1) + withdraw(1) leaves NO live zombie window", async () => {
    const { atk, st } = await pool();
    await st.connect(atk).fund(2n);                 // parks (pool empty)
    await st.connect(atk).stake(1n);                // flushes through _startDrip
    await st.connect(atk).withdraw(1n);             // empties the pool
    const now = BigInt(await time.latest());
    const pf = await st.periodFinish();
    console.log(`   rewardRate=${await st.rewardRate()}  periodFinish-now=${pf > now ? pf - now : 0n}  pending=${await st.pendingRewards()}`);
    expect(await st.rewardRate()).to.equal(0n);
    expect(pf <= now).to.equal(true);               // no live window survives an empty pool
    expect(await st.pendingRewards()).to.equal(2n); // the dust is CARRIED, not stranded and not armed
  });

  it("the capture no longer captures: a tail staker cannot take the reservoir", async () => {
    const { atk, honest, st } = await pool();
    // arm exactly as the exploit did
    await st.connect(atk).fund(2n);
    await st.connect(atk).stake(1n);
    await st.connect(atk).withdraw(1n);
    // the pad funds the real reservoir while the pool is empty
    await st.fund(E(96978138));
    expect(await st.totalStaked()).to.equal(0n);
    // attacker returns at what WAS the tail of the zombie window
    await time.increase(30 * 86400 - 2);
    await st.connect(atk).stake(1n);
    await time.increase(2);
    const atkEarned = await st.earned(atk.address);
    // an honest staker arrives right after
    await st.connect(honest).stake(E(1000));
    await time.increase(7 * 86400);
    console.log(`   attacker earned after 2s in the tail : ${ethers.formatEther(atkEarned)}`);
    console.log(`   attacker earned after 7 more days    : ${ethers.formatEther(await st.earned(atk.address))}`);
    console.log(`   honest staker earned over 7 days     : ${ethers.formatEther(await st.earned(honest.address))}`);
    // 2 seconds of a full 30-day drip on 96,978,138 is ~74.8 tokens — which is CORRECT: the attacker was the
    // only staker for two seconds and earned two seconds of drip. Before the fix the zombie window compressed
    // the whole reservoir into those same two seconds and they took 96,978,138 (100.00%).
    const pct = Number(ethers.formatEther(atkEarned)) / 96978138 * 100;
    console.log(`   attacker share of the reservoir      : ${pct.toFixed(6)}%  (was 100.000000%)`);
    expect(atkEarned).to.be.lt(E(100));
    expect(await st.earned(honest.address)).to.be.gt(E(1000)); // honest stakers actually earn now
  });

  it("still cannot pay out more than was funded (the headline guarantee)", async () => {
    const { atk, honest, st } = await pool();
    await st.connect(atk).stake(E(1000));
    await st.fund(E(10000));
    await time.increase(45 * 86400);
    const total = (await st.earned(atk.address)) + (await st.earned(honest.address));
    console.log(`   funded 10000, total earned ${ethers.formatEther(total)}`);
    expect(total).to.be.lte(E(10000));
  });
});
