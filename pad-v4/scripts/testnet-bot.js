/* LIVE TESTNET BOT — launches a real pad on Robinhood testnet via the freshly-deployed CurvePadFactoryV4 and
 * exercises the ETH-native fee model on-chain: a buy, a referral buy, and a sell — then reads back the tick move
 * and the accrued fee books (platform / buffer / referral / creator / floor). Graduation is NOT attempted (testnet
 * has no v4 PositionManager, and the production geometry needs ~4 ETH to sell out) — it's proven on the mainnet fork.
 * Run: SWAP_ROUTER=<router> npx hardhat run scripts/testnet-bot.js --network robinhoodTestnet
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { mineHookSalt, hookInitCode } = require("./mine");

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const MIN = 4295128739n + 1n, MAX = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const abi = ethers.AbiCoder.defaultAbiCoder();
const T0 = { type: 0 };

function poolIdOf(k) {
  return ethers.keccak256(abi.encode(["tuple(address,address,uint24,int24,address)"], [[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]]));
}

async function main() {
  const D = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy.curve.json"), "utf8"));
  const C = D.contracts;
  const SW_ADDR = process.env.SWAP_ROUTER;
  if (!SW_ADDR) throw new Error("set SWAP_ROUTER=<PoolSwapTest address>");
  const FEE = D.defaults.lpFee, TS = 100;
  const START = D.defaults.startTickMag, GRAD = START - D.defaults.curveWidth;

  const [dev] = await ethers.getSigners();
  const ref = ethers.Wallet.createRandom().address; // an external referrer (needs no funds — just accrues)
  console.log(`Bot running as ${dev.address}  | referrer ${ref}\n`);

  const factory = await ethers.getContractAt("CurvePadFactoryV4", C.curveFactory);
  const sv = await ethers.getContractAt("RobinStateView", C.stateView);
  const SW = await ethers.getContractAt("PoolSwapTest", SW_ADDR);

  // ── launch a pad: 1B supply @ 73% curve / 27% reserve, ts=100, dev is the creator ──
  const ONE = 10n ** 18n;
  const cfg = {
    name: "Robin Testnet", symbol: "rTEST", decimals: 18,
    supply: 1_000_000_000n * ONE, curveSupply: 730_000_000n * ONE, reserveSupply: 270_000_000n * ONE,
    tickSpacing: TS, startTickMag: 0, creator: dev.address,
  };
  const TokenF = await ethers.getContractFactory("PadToken");
  const tokenSalt = ethers.id("rtest-" + Date.now());
  const tokenInit = ethers.concat([TokenF.bytecode, abi.encode(["string", "string", "uint8", "uint256", "address"], [cfg.name, cfg.symbol, 18, cfg.supply, C.curveFactory])]);
  const predicted = ethers.getCreate2Address(C.deterministicDeployer, tokenSalt, ethers.keccak256(tokenInit));
  const HookF = await ethers.getContractFactory("RobinFeeHook");
  const { salt: hookSalt } = mineHookSalt(C.deterministicDeployer, hookInitCode(HookF.bytecode, POOL_MANAGER, C.curveFactory, C.feeWalletRegistry, predicted));
  const curveSalt = ethers.id("rtest-curve-" + Date.now());

  const [token, hook, curveAddr] = await factory.launch.staticCall(cfg, tokenSalt, hookSalt, curveSalt);
  const ltx = await (await factory.launch(cfg, tokenSalt, hookSalt, curveSalt, T0)).wait();
  console.log(`✓ launched  token ${token}\n           hook  ${hook}\n           curve ${curveAddr}\n           tx ${ltx.hash}`);

  const key = { currency0: ZERO, currency1: token, fee: FEE, tickSpacing: TS, hooks: hook };
  const poolId = poolIdOf(key);
  const hookC = await ethers.getContractAt("RobinFeeHook", hook);
  const tok = await ethers.getContractAt("PadToken", token);
  const tick = async () => Number((await sv.getSlot0(poolId))[1]);
  console.log(`  start tick ${await tick()} (expected ${START}); grad ceiling ${GRAD}\n`);

  const buy = async (amt, data = "0x", tag) => {
    const r = await (await SW.swap(key, { zeroForOne: true, amountSpecified: -amt, sqrtPriceLimitX96: MIN }, { takeClaims: false, settleUsingBurn: false }, data, { value: amt, ...T0 })).wait();
    console.log(`  ✓ ${tag}  spent ${ethers.formatEther(amt)} ETH → tick ${await tick()}  (tx ${r.hash})`);
  };

  // ── 1) a plain buy ──
  await buy(ethers.parseEther("0.001"), "0x", "buy #1        ");
  // ── 2) a buy WITH a referral link (hookData = referrer) ──
  await buy(ethers.parseEther("0.001"), abi.encode(["address"], [ref]), "buy #2 (ref)  ");
  // ── 3) sell half of what we hold back ──
  const bal = await tok.balanceOf(dev.address);
  await (await tok.approve(SW_ADDR, ethers.MaxUint256, T0)).wait();
  const sr = await (await SW.swap(key, { zeroForOne: false, amountSpecified: -(bal / 2n), sqrtPriceLimitX96: MAX }, { takeClaims: false, settleUsingBurn: false }, "0x", T0)).wait();
  console.log(`  ✓ sell half  ${ethers.formatUnits(bal / 2n, 18)} rTEST → tick ${await tick()}  (tx ${sr.hash})\n`);

  // ── read back the accrued fee books (all money-side ETH claims / real ETH) ──
  console.log("Fee books after the tape:");
  console.log(`  platformOwed  ${ethers.formatEther(await hookC.platformOwed(poolId, 0))} ETH (buy tax → platform)`);
  console.log(`  bufferOwed    ${ethers.formatEther(await hookC.bufferOwed(poolId))} ETH (→ platform at graduation)`);
  console.log(`  referralOwed  ${ethers.formatEther(await hookC.referralOwed(ref, ZERO))} ETH (external referrer)`);
  console.log(`  creatorOwed   ${ethers.formatEther(await hookC.creatorOwed(poolId, 0))} ETH (sell tax → creator)`);
  console.log(`  floorOwed     ${ethers.formatEther(await hookC.floorOwed(poolId, 0))} ETH (sell tax → floor)`);
  console.log(`  dev token bal ${ethers.formatUnits(await tok.balanceOf(dev.address), 18)} rTEST`);

  // append the launched pad to the manifest so the staging bench / future runs can find it
  D.testnetPad = { token, hook, curve: curveAddr, poolId, swapRouter: SW_ADDR };
  fs.writeFileSync(path.join(__dirname, "..", "deploy.curve.json"), JSON.stringify(D, null, 2));
  console.log(`\n✓ pad recorded in deploy.curve.json (chainId ${Number(network.config.chainId)})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
