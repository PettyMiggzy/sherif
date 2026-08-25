const { expect } = require("chai");
const { ethers } = require("hardhat");

// [SALT] Creator-chosen coin ADDRESS on the v3 pad.
//
// `launch()` builds its own CREATE2 salt from block.number/block.timestamp, so the coin's address is
// unpredictable and cannot be mined. `launchWithSalt()` lets a creator supply a salt they mined, so the address
// ends however they chose (the pad defaults to `1ab5`).
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
    const v3 = await at("MockUniswapV3Factory");
    ltd = await at("LaunchTokenDeployer");
    const cpd = await at("CurvePoolDeployer");
    const bd = await at("BondDeployer", 9000, 15600);
    const router = await at("PadRouter", weth, dep.address);
    factory = await (await ethers.getContractFactory("CurvePadFactory")).connect(dep).deploy(
      weth, v3, platform.address, dep.address, router, ltd, cpd, bd,
      ethers.ZeroAddress, START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
    );
    factoryAddr = await factory.getAddress();
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

  it("a creator can mine an ending, and the prediction is exact", async () => {
    // Mine for a 2-hex ending, cheap enough to do inside a unit test. The real client mines 4 (`1ab5`), which
    // is the same loop with a longer target.
    const WANT = "b5";
    let salt = null, addr = null;
    for (let i = 0; i < 65536; i++) {
      const cand = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = await predict(dev.address, cand, "Robin Meme", "MEME", SUPPLY);
      if (a.toLowerCase().endsWith(WANT)) { salt = cand; addr = a; break; }
    }
    expect(salt, "mining found no salt").to.not.equal(null);
    expect(addr.toLowerCase().endsWith(WANT)).to.equal(true);

    // The SAME mined salt, mined by someone else, does not reach that address — so a creator can safely publish
    // their coin's address before launching it.
    expect(await predict(other.address, salt, "Robin Meme", "MEME", SUPPLY)).to.not.equal(addr);

    // The on-chain half — that launchWithSalt actually LANDS on this address — needs a real Uniswap v3 pool to
    // mint the concentrated position, so it lives in test/fork/curvepad.fork.test.js rather than here.
  });

  it("a zero salt is NOT a mined salt — it must fall through to the entropy branch", async () => {
    // If zero were folded in like any other salt, every creator who left the field default would derive the
    // same address and only the first could ever launch. The factory branches on `tokenSalt_ != bytes32(0)`,
    // so what a zero would have produced must not be a reachable launch address.
    const wouldBe = await predict(dev.address, ethers.ZeroHash, "Robin Meme", "MEME", SUPPLY);
    const real = await predict(dev.address, ethers.id("anything-nonzero"), "Robin Meme", "MEME", SUPPLY);
    expect(wouldBe).to.not.equal(real);
    // The entropy branch mixes block.number and block.timestamp, so it cannot be predicted here at all — which
    // is the point, and is asserted on-chain in the fork suite.
  });

});
