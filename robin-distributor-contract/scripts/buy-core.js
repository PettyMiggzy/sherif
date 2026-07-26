// Self-contained buyer for ROBIN on Robinhood Chain (Uniswap SwapRouter02).
//
// BUY_METHOD:
//   "single" (default) → exactInputSingle(WETH→ROBIN, 1% pool)
//   "path"             → exactInput with an encoded WETH→ROBIN path — mirrors the
//                        other bot's swaps on this pool.
// Both send ETH as msg.value and let the router wrap it; amountOutMinimum is 0 so a
// tiny buy never reverts on size. Set BUY_AMOUNT_MIN_WEI + BUY_AMOUNT_MAX_WEI to
// randomize the size of every buy (varied amounts) instead of a fixed one.
const { ethers } = require("ethers");

const ROUTER = process.env.ROUTER || "0xCaf681a66D020601342297493863E78C959E5cb2";
const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const TOKEN_OUT = process.env.TOKEN_OUT || "0x6696FE29288B586017E6f264c0091DBA6C5ebeaf";
const POOL_FEE = Number(process.env.POOL_FEE || 10000);
const BUY_METHOD = (process.env.BUY_METHOD || "single").toLowerCase();
const AMIN = process.env.BUY_AMOUNT_MIN_WEI ? BigInt(process.env.BUY_AMOUNT_MIN_WEI) : 0n;
const AMAX = process.env.BUY_AMOUNT_MAX_WEI ? BigInt(process.env.BUY_AMOUNT_MAX_WEI) : 0n;
// A cold first buy per wallet costs ~171k gas, warm ~129k. Cap generously — you only
// pay for gas USED; too LOW a ceiling makes the tx run out of gas and burn it.
const BUY_GAS_LIMIT = BigInt(process.env.BUY_GAS_LIMIT || 200000);

const ABI_SINGLE = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const ABI_PATH = ["function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)"];
const PATH = ethers.solidityPacked(["address", "uint24", "address"], [WETH, POOL_FEE, TOKEN_OUT]);

// Amount for one buy: random in [AMIN, AMAX] when a range is set, else `base`.
function pickAmount(base) {
  if (AMIN > 0n && AMAX > AMIN) {
    const span = AMAX - AMIN;
    return AMIN + BigInt(Math.floor(Math.random() * (Number(span) + 1)));
  }
  return base;
}
// Largest a single buy can cost — used for funding + afford checks.
function maxAmountFor(base) { return AMAX > 0n ? AMAX : base; }
function reserveWei(gasPrice, base) { return BUY_GAS_LIMIT * gasPrice + maxAmountFor(base); }

// One buy from `wallet` for a concrete `amountIn`. Legacy tx, explicit gasLimit,
// value = amountIn (the router wraps it). Uses exactInput (path) or exactInputSingle.
async function buyOnce(wallet, amountIn, gasPrice) {
  const overrides = { value: amountIn, type: 0, gasPrice, gasLimit: BUY_GAS_LIMIT };
  if (BUY_METHOD === "path") {
    const router = new ethers.Contract(ROUTER, ABI_PATH, wallet);
    return router.exactInput({ path: PATH, recipient: wallet.address, amountIn, amountOutMinimum: 0n }, overrides);
  }
  const router = new ethers.Contract(ROUTER, ABI_SINGLE, wallet);
  return router.exactInputSingle(
    { tokenIn: WETH, tokenOut: TOKEN_OUT, fee: POOL_FEE, recipient: wallet.address, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n },
    overrides,
  );
}

// Buy as many times as this wallet can afford, randomizing each amount if configured.
async function drainWalletBuys({ wallet, provider, amountIn, gasPrice, maxBuys = 100000, log = () => {} }) {
  const need = reserveWei(gasPrice, amountIn);
  let buys = 0, spentWei = 0n;
  while (buys < maxBuys) {
    let bal;
    try { bal = await provider.getBalance(wallet.address, "latest"); } catch { break; }
    if (bal < need) break;
    const amt = pickAmount(amountIn);
    try {
      const tx = await buyOnce(wallet, amt, gasPrice);
      const rc = await tx.wait();
      buys++;
      spentWei += amt + rc.gasUsed * (rc.gasPrice ?? gasPrice);
    } catch (e) {
      log(`    buy failed ${wallet.address.slice(0, 10)}…: ${e.shortMessage || e.message}`);
      break;
    }
  }
  return { buys, spentWei };
}

module.exports = { buyOnce, drainWalletBuys, pickAmount, reserveWei, maxAmountFor, ROUTER, WETH, TOKEN_OUT, POOL_FEE, BUY_METHOD, BUY_GAS_LIMIT };
