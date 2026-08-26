const { expect } = require("chai");
const { ethers } = require("hardhat");
const V3_FACTORY_ART = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const { mineFor } = require("./helpers/brand");

// [SALT] Who a mined coin ADDRESS belongs to.
//
// Every coin address must end in `1ab5` (PadBrand), so `launchWithSalt` is not an option a creator may take —
// it is the only way to launch, and `launch()` reverts `SaltRequired`. The brand rule itself is pinned in
// brand-1ab5.test.js. What THIS file pins is the other half: whose address a mined salt produces.
//
// The property this file exists to defend is the BINDING. An earlier version of the change passed the creator's
// salt straight through, on the reasoning that LaunchTokenDeployer already folds msg.sender into the CREATE2
// salt. It does — but on this path msg.sender is THE FACTORY, one constant address for every creator, so that
// fold separates a direct caller of the public deployer from the factory and separates NOTHING between two
// creators. `p.dev` is not a LaunchToken constructor argument either, so the coin's address did not depend on
// who was launching it: anyone who learned a salt could take that exact address with themselves as dev. A salt
// is public the moment a launch tx is mined — including a REVERTED one, whose calldata lives in block history
// forever. The factory now folds msg.sender in itself.

const START_TICK_MAG = 201600, CURVE_WIDTH = 23000, MIN_GRAD_WIDTH = 22800;

describe("[SALT] a mined coin address belongs to the creator who mined it", () => {
  let dep, platform, dev, other, factory, ltd, factoryAddr;

  before(async () => {
    [dep, platform, dev, other] = (await ethers.getSigners()).slice(-4);
    const at = async (name, ...args) =>
      (await ethers.getContractFactory(name)).connect(dep).deploy(...args).then((c) => c.getAddress());
    const weth = await at("MockWETH9");
    // The REAL v3 factory, deployed locally from @uniswap/v3-core bytecode. The repo's mock cannot mint the
    // concentrated position CurvePool seeds, so with it no launch completes and the prediction below could
    // only ever be compared against itself — which is exactly how a wrong formula would slip through.
    const v3 = await new ethers.ContractFactory(V3_FACTORY_ART.abi, V3_FACTORY_ART.bytecode, dep)
      .deploy().then((c) => c.getAddress());
    ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    const router = await at("PadRouter", weth, dep.address);
    factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd,
      ethers.ZeroAddress, START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    );
    factoryAddr = await factory.getAddress();
    // the router only accepts registrations from a factory it knows; without this every launch reverts OnlyFactory
    await (await (await ethers.getContractAt("PadRouter", router)).connect(dep).setFactory(factoryAddr)).wait();
  });

  // The full chain: factory computes keccak(creator, tokenSalt); LaunchTokenDeployer then computes
  // keccak(msg.sender = factory, thatSalt) and CREATE2s LaunchToken with it.
  async function predict(creator, tokenSalt, name, symbol, supply) {
    const inner = ethers.keccak256(
      ethers.solidityPacked(["address", "bytes32"], [creator, tokenSalt])
    );
    const outer = ethers.keccak256(
      ethers.solidityPacked(["address", "bytes32"], [factoryAddr, inner])
    );
    const guard = { deadSecs: 0, phase1Secs: 0, antiSnipeSecs: 0, maxTxBps1: 0, maxWalletBps1: 0, maxTxBps2: 0, maxWalletBps2: 0, cooldownSecs: 0 };
    const art = await ethers.getContractFactory("LaunchToken");
    const initCode = ethers.concat([
      art.bytecode,
      art.interface.encodeDeploy([name, symbol, supply, factoryAddr, guard]),
    ]);
    return ethers.getCreate2Address(ltd, outer, ethers.keccak256(initCode));
  }

  const SUPPLY = 1_000_000_000n * 10n ** 18n;
  const SALT = ethers.id("a-salt-someone-mined");

  it("THE FIX: the same salt from a different caller yields a DIFFERENT coin address", async () => {
    const mine = await predict(dev.address, SALT, "Robin Meme", "MEME", SUPPLY);
    const theirs = await predict(other.address, SALT, "Robin Meme", "MEME", SUPPLY);
    expect(mine).to.not.equal(theirs);

    // Without the binding these two would be byte-identical, because nothing else in the CREATE2 preimage
    // varies with the caller: name, symbol, supply, the factory and the all-zero GuardConfig are the same, and
    // `dev` is not a constructor argument at all. That equality is the whole attack.
    const unbound = ethers.getCreate2Address(
      ltd,
      ethers.keccak256(ethers.solidityPacked(["address", "bytes32"], [factoryAddr, SALT])),
      ethers.keccak256(await (async () => {
        const art = await ethers.getContractFactory("LaunchToken");
        const guard = { deadSecs: 0, phase1Secs: 0, antiSnipeSecs: 0, maxTxBps1: 0, maxWalletBps1: 0, maxTxBps2: 0, maxWalletBps2: 0, cooldownSecs: 0 };
        return ethers.concat([art.bytecode, art.interface.encodeDeploy(["Robin Meme", "MEME", SUPPLY, factoryAddr, guard])]);
      })())
    );
    expect(unbound).to.not.equal(mine); // the bound address is not the one a leaked salt would reach
  });

  it("a creator can mine the brand, and the prediction is exact", async function () {
    this.timeout(300000); // a full 16-bit suffix is ~65k tries
    // Mining now targets the mandatory `1ab5`, not a short ending chosen for test speed. `mineFor` runs the
    // same miner the site and the bot run, so this also pins that miner against this file's own `predict`.
    const { salt, addr } = await mineFor(
      factory, dev.address, { name: "Robin Meme", symbol: "MEME" }, SUPPLY, "tokensalt-mine");
    expect(addr.toLowerCase().endsWith("1ab5")).to.equal(true);
    expect(await predict(dev.address, salt, "Robin Meme", "MEME", SUPPLY)).to.equal(addr);

    // The SAME mined salt, replayed by someone else, does not reach that address — so a creator can safely
    // publish their coin's address before launching it. Under the brand rule the replay cannot even launch:
    // the address it does reach is unbranded, so the factory rejects it outright.
    const theirs = await predict(other.address, salt, "Robin Meme", "MEME", SUPPLY);
    expect(theirs).to.not.equal(addr);
    expect(theirs.toLowerCase().endsWith("1ab5")).to.equal(false);

    // ...and the factory really does land there. Without this the assertions above only prove the helper is
    // self-consistent: a prediction formula that was wrong in the same way twice would pass them all.
    const [landed] = await factory.connect(dev).launchWithSalt.staticCall(
      { name: "Robin Meme", symbol: "MEME", dev: dev.address,
        tax: { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address } },
      salt
    );
    expect(landed).to.equal(addr);
  });

  it("a zero salt is refused by name — there is no entropy fallback left", async () => {
    // A zero salt used to fall through to a block-derived salt. Under the brand rule that branch could only
    // ever produce an unbranded address, so it is gone: zero now means "you have not mined yet", and the
    // factory says exactly that instead of failing later on the suffix.
    await expect(
      factory.connect(dev).launchWithSalt(
        { name: "Robin Meme", symbol: "MEME", dev: dev.address,
          tax: { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address } },
        ethers.ZeroHash
      )
    ).to.be.revertedWithCustomError(factory, "SaltRequired");
  });

});
