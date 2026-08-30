const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// [CREDITS] Prepaid credits for the image generator.
//
// The properties worth testing are the ones where being wrong costs money or destroys the ledger:
//   • the OPERATOR key is online and assumed stealable — alone it must be able to do NOTHING
//   • a spend authorisation must not be replayable, reusable across contracts, or survive its deadline
//   • the owner must not be able to spend a customer's credits, only grant them
//   • an address the caller names must not be able to burn the operator's gas
const E = (n) => ethers.parseEther(String(n));
const PRICE = ethers.parseEther("0.00001"); // ~3x a $0.01 image, at some ETH price

describe("[CREDITS] art credits", function () {
  this.timeout(120000);
  let owner, op, alice, bob, c, addr, chainId;

  const sign = async (signer, { user, amount, nonce, deadline }) =>
    signer.signTypedData(
      { name: "RobinArtCredits", version: "1", chainId, verifyingContract: addr },
      { Spend: [
        { name: "user", type: "address" }, { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] },
      { user, amount, nonce, deadline },
    );

  const far = async () => (await time.latest()) + 3600;

  beforeEach(async () => {
    [owner, op, alice, bob] = (await ethers.getSigners()).slice(-4);
    c = await (await ethers.getContractFactory("ArtCredits")).connect(owner).deploy(owner.address, PRICE);
    addr = await c.getAddress();
    chainId = Number((await ethers.provider.getNetwork()).chainId);
    await (await c.connect(owner).setOperator(op.address, true)).wait();
  });

  it("buying credits costs what quote says, and the ETH stays in the contract", async () => {
    const [cost] = await c.quote(10);
    expect(cost).to.equal(PRICE * 10n);
    await (await c.connect(alice).buy(10, PRICE, { value: cost })).wait();
    expect(await c.credits(alice.address)).to.equal(10n);
    expect(await ethers.provider.getBalance(addr)).to.equal(cost);
    expect(await c.totalSold()).to.equal(10n);
  });

  it("a price rise cannot be slipped past a buyer mid-flight", async () => {
    // The owner can retune the price, so a raise could land in the same block as a purchase. The buyer's
    // ceiling is their own protection and it is a required argument, not an optional one.
    await (await c.connect(owner).setPrice(PRICE * 5n)).wait();
    await expect(c.connect(alice).buy(10, PRICE, { value: PRICE * 50n }))
      .to.be.revertedWithCustomError(c, "PriceMoved");
  });

  it("underpaying buys nothing", async () => {
    await expect(c.connect(alice).buy(10, PRICE, { value: PRICE * 9n }))
      .to.be.revertedWithCustomError(c, "Underpaid");
  });

  it("a customer's signature spends their credits, relayed by the operator", async () => {
    await (await c.connect(alice).buy(5, PRICE, { value: PRICE * 5n })).wait();
    const deadline = await far();
    const sig = await sign(alice, { user: alice.address, amount: 2, nonce: 7, deadline });
    await (await c.connect(op).spendWithSig(alice.address, 2, 7, deadline, sig)).wait();
    expect(await c.credits(alice.address)).to.equal(3n);
    expect(await c.totalSpent()).to.equal(2n);
  });

  it("THE OPERATOR KEY ALONE IS INERT — it cannot spend, mint, price, or withdraw", async () => {
    // The whole security model. This key lives on an internet-facing box and is assumed stealable.
    await (await c.connect(alice).buy(5, PRICE, { value: PRICE * 5n })).wait();
    const deadline = await far();

    // ...cannot spend without the customer's signature
    const forged = await sign(op, { user: alice.address, amount: 5, nonce: 1, deadline });
    await expect(c.connect(op).spendWithSig(alice.address, 5, 1, deadline, forged))
      .to.be.revertedWithCustomError(c, "BadSignature");
    await expect(c.connect(op).spendWithSig(alice.address, 5, 1, deadline, "0x"))
      .to.be.revertedWithCustomError(c, "BadSignature");

    // ...cannot mint itself credits, move money, change the price, or make another operator
    await expect(c.connect(op).grant(op.address, 1000)).to.be.reverted;
    await expect(c.connect(op).withdraw(op.address, 0)).to.be.reverted;
    await expect(c.connect(op).setPrice(1)).to.be.reverted;
    await expect(c.connect(op).setOperator(bob.address, true)).to.be.reverted;
    expect(await c.credits(alice.address)).to.equal(5n);
  });

  it("an authorisation cannot be replayed", async () => {
    await (await c.connect(alice).buy(5, PRICE, { value: PRICE * 5n })).wait();
    const deadline = await far();
    const sig = await sign(alice, { user: alice.address, amount: 1, nonce: 42, deadline });
    await (await c.connect(op).spendWithSig(alice.address, 1, 42, deadline, sig)).wait();
    await expect(c.connect(op).spendWithSig(alice.address, 1, 42, deadline, sig))
      .to.be.revertedWithCustomError(c, "NonceUsed");
  });

  it("an authorisation expires", async () => {
    await (await c.connect(alice).buy(5, PRICE, { value: PRICE * 5n })).wait();
    const deadline = (await time.latest()) + 60;
    const sig = await sign(alice, { user: alice.address, amount: 1, nonce: 9, deadline });
    await time.increase(120);
    await expect(c.connect(op).spendWithSig(alice.address, 1, 9, deadline, sig))
      .to.be.revertedWithCustomError(c, "SigExpired");
  });

  it("an authorisation for one deployment does not work on another", async () => {
    // The domain separator binds the signature to this contract. Without that, a signature harvested from a
    // test or a previous deployment would spend on the live one.
    const other = await (await ethers.getContractFactory("ArtCredits")).connect(owner).deploy(owner.address, PRICE);
    await (await other.connect(owner).setOperator(op.address, true)).wait();
    await (await other.connect(alice).buy(5, PRICE, { value: PRICE * 5n })).wait();

    const deadline = await far();
    const sigForThis = await sign(alice, { user: alice.address, amount: 1, nonce: 3, deadline }); // domain = c
    await expect(other.connect(op).spendWithSig(alice.address, 1, 3, deadline, sigForThis))
      .to.be.revertedWithCustomError(other, "BadSignature");
  });

  it("the owner can hand out credits but cannot spend anyone's", async () => {
    await (await c.connect(owner).grant(alice.address, 3)).wait();
    expect(await c.credits(alice.address)).to.equal(3n);
    const deadline = await far();
    const ownerSig = await sign(owner, { user: alice.address, amount: 3, nonce: 1, deadline });
    // Even as owner AND operator, without alice's signature there is no path to her balance.
    await (await c.connect(owner).setOperator(owner.address, true)).wait();
    await expect(c.connect(owner).spendWithSig(alice.address, 3, 1, deadline, ownerSig))
      .to.be.revertedWithCustomError(c, "BadSignature");
  });

  it("withdrawing revenue never touches anyone's credit balance", async () => {
    await (await c.connect(alice).buy(10, PRICE, { value: PRICE * 10n })).wait();
    const before = await ethers.provider.getBalance(bob.address);
    await (await c.connect(owner).withdraw(bob.address, 0)).wait(); // 0 = everything
    expect(await ethers.provider.getBalance(bob.address) - before).to.equal(PRICE * 10n);
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    expect(await c.credits(alice.address)).to.equal(10n); // still spendable — credits are compute, not a deposit
  });

  it("a withdraw to an address that rejects ETH reverts instead of silently succeeding", async () => {
    await (await c.connect(alice).buy(1, PRICE, { value: PRICE })).wait();
    const bad = await (await ethers.getContractFactory("RejectEth")).deploy();
    await expect(c.connect(owner).withdraw(await bad.getAddress(), 0))
      .to.be.revertedWithCustomError(c, "PayoutFailed");
  });

  it("paying in the pad token sends it straight to the sink, never into this contract", async () => {
    const tok = await (await ethers.getContractFactory("MockERC20")).connect(owner).deploy(E(1_000_000));
    const T = await tok.getAddress();
    await (await c.connect(owner).setPayToken(T, E(100), bob.address)).wait(); // bob stands in for the staking pool
    await (await tok.connect(owner).transfer(alice.address, E(1000))).wait();
    await (await tok.connect(alice).approve(addr, ethers.MaxUint256)).wait();

    await (await c.connect(alice).buyWithToken(5, E(100))).wait();
    expect(await c.credits(alice.address)).to.equal(5n);
    expect(await tok.balanceOf(bob.address)).to.equal(E(500));
    expect(await tok.balanceOf(addr)).to.equal(0n); // nothing custodied, nothing to strand
  });

  it("the token rail is off until it is configured", async () => {
    await expect(c.connect(alice).buyWithToken(1, E(100))).to.be.revertedWithCustomError(c, "PayTokenOff");
  });

  it("plain ETH sent to the address is REFUSED, not minted at whatever the price happens to be", async () => {
    // It used to mint at the live price, skipping the very ceiling `buy` exists to enforce — so a setPrice
    // landing first turned a plain send into one credit for one ETH, unrefundable by design. Reverting
    // costs the sender nothing; the ETH never leaves their wallet.
    await expect(alice.sendTransaction({ to: addr, value: PRICE * 3n }))
      .to.be.revertedWithCustomError(c, "UseBuy");
    expect(await c.credits(alice.address)).to.equal(0n);

    // And the priced path still works, with the ceiling doing its job.
    await (await c.connect(alice).buy(3, PRICE, { value: PRICE * 3n })).wait();
    expect(await c.credits(alice.address)).to.equal(3n);
    await expect(c.connect(alice).buy(1, PRICE - 1n, { value: PRICE }))
      .to.be.revertedWithCustomError(c, "PriceMoved");
  });

  it("a smart-contract wallet can authorise a spend", async () => {
    const magic = "0xdeadbeef";
    const w = await (await ethers.getContractFactory("Mock1271Wallet")).deploy(magic);
    const wAddr = await w.getAddress();
    await (await c.connect(owner).grant(wAddr, 4)).wait();
    const deadline = await far();
    await (await c.connect(op).spendWithSig(wAddr, 2, 1, deadline, magic)).wait();
    expect(await c.credits(wAddr)).to.equal(2n);
    await expect(c.connect(op).spendWithSig(wAddr, 1, 2, deadline, "0xbadbadba"))
      .to.be.revertedWithCustomError(c, "BadSignature");
  });

  it("a hostile 'wallet' cannot burn the operator's gas", async () => {
    // The operator pays for this transaction and `user` is an address the CALLER chose. Uncapped, anyone
    // could name a contract that loops forever and drain the relayer's gas on every attempt.
    const burner = await (await ethers.getContractFactory("GasBurner1271")).deploy();
    const bAddr = await burner.getAddress();
    await (await c.connect(owner).grant(bAddr, 5)).wait();
    const deadline = await far();
    await expect(c.connect(op).spendWithSig(bAddr, 1, 1, deadline, "0x00", { gasLimit: 1_000_000 }))
      .to.be.revertedWithCustomError(c, "BadSignature"); // dies locally, not out of gas
  });

  it("you cannot spend credits you do not have", async () => {
    await (await c.connect(alice).buy(1, PRICE, { value: PRICE })).wait();
    const deadline = await far();
    const sig = await sign(alice, { user: alice.address, amount: 2, nonce: 1, deadline });
    await expect(c.connect(op).spendWithSig(alice.address, 2, 1, deadline, sig))
      .to.be.revertedWithCustomError(c, "NotEnoughCredits");
  });

  it("a customer can settle their own balance with no operator at all", async () => {
    await (await c.connect(alice).buy(4, PRICE, { value: PRICE * 4n })).wait();
    await (await c.connect(alice).spendSelf(1)).wait();
    expect(await c.credits(alice.address)).to.equal(3n);
  });
});
