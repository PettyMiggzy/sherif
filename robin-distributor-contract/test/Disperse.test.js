// Proves the stateless one-tx multisend against the real 1000 addresses:
// exact amounts, overpay refund, underpay revert, and that batches fit the cap
// — and demonstrates the fresh-vs-existing gas difference (1000 existing in ONE tx).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("node:fs"), path = require("node:path");

const GAS_CAP = 16_777_216n; // Robinhood Chain per-tx cap (2^24)
const RECIPIENTS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "recipients.json"), "utf8"))
  .map((a) => ethers.getAddress(a));
const UNIT = ethers.parseUnits((0.0000814 / 3500).toFixed(18), 18); // $0.0000814 @ $3500

async function deploy() {
  const D = await ethers.getContractFactory("Disperse");
  const d = await D.deploy();
  await d.waitForDeployment();
  return d;
}
async function balancesOf(list) {
  const out = [];
  for (const a of list) out.push(await ethers.provider.getBalance(a));
  return out;
}

describe("Disperse", function () {
  this.timeout(600000);

  it("pays exactly amountEach to every recipient (batch under the gas cap)", async () => {
    const d = await deploy();
    const [owner] = await ethers.getSigners();
    const before = await balancesOf(RECIPIENTS);

    // 1000 FRESH wallets: send in batches of 400 to stay under the cap.
    let maxGas = 0n;
    for (let i = 0; i < RECIPIENTS.length; i += 400) {
      const slice = RECIPIENTS.slice(i, i + 400);
      const rc = await (await d.connect(owner).disperseEqual(slice, UNIT, { value: UNIT * BigInt(slice.length) })).wait();
      if (rc.gasUsed > maxGas) maxGas = rc.gasUsed;
    }
    expect(maxGas).to.be.lessThan(GAS_CAP);

    const after = await balancesOf(RECIPIENTS);
    for (let i = 0; i < RECIPIENTS.length; i++) expect(after[i] - before[i]).to.equal(UNIT);
    // stateless: contract holds nothing afterwards
    expect(await ethers.provider.getBalance(await d.getAddress())).to.equal(0n);
  });

  it("now that the wallets exist, all 1000 fit in ONE tx and cost ~half the gas", async () => {
    const d = await deploy();
    const [owner] = await ethers.getSigners();
    const before = await balancesOf(RECIPIENTS);
    // recipients already exist from the previous test → one tx for all 1000
    const rc = await (await d.connect(owner).disperseEqual(RECIPIENTS, UNIT, { value: UNIT * BigInt(RECIPIENTS.length) })).wait();
    expect(rc.gasUsed).to.be.lessThan(GAS_CAP);
    const perWallet = rc.gasUsed / BigInt(RECIPIENTS.length);
    expect(perWallet).to.be.lessThan(15000n); // ~10k for existing accounts, well under 21k
    const after = await balancesOf(RECIPIENTS);
    for (let i = 0; i < RECIPIENTS.length; i++) expect(after[i] - before[i]).to.equal(UNIT);
    console.log(`      → 1000 wallets in ONE tx: ${rc.gasUsed} gas (${perWallet}/wallet)`);
  });

  it("refunds any overpayment to the sender", async () => {
    const d = await deploy();
    const [owner] = await ethers.getSigners();
    const list = RECIPIENTS.slice(0, 10);
    const need = UNIT * 10n;
    const over = need + ethers.parseEther("1");
    const balBefore = await ethers.provider.getBalance(owner.address);
    const rc = await (await d.connect(owner).disperseEqual(list, UNIT, { value: over })).wait();
    const gasCost = rc.gasUsed * (rc.gasPrice ?? 0n);
    const balAfter = await ethers.provider.getBalance(owner.address);
    // owner only lost `need` + gas (the extra 1 ETH came back)
    expect(balBefore - balAfter - gasCost).to.equal(need);
    expect(await ethers.provider.getBalance(await d.getAddress())).to.equal(0n);
  });

  it("reverts if msg.value can't cover the total", async () => {
    const d = await deploy();
    const list = RECIPIENTS.slice(0, 5);
    await expect(d.disperseEqual(list, UNIT, { value: UNIT * 4n })).to.be.revertedWith("insufficient value");
  });
});
