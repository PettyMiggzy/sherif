// Self-contained buyer — replicates the exact swap that's already working on-chain
// (decoded from a live buy tx):
//   Uniswap SwapRouter02.exactInputSingle(WETH -> ROBIN, fee 10000 / 1% pool),
//   amountOutMinimum = 0  → the swap can NEVER revert on output size, so any
//   amountIn (down to the floor) is safe.
// ETH is sent as msg.value; the router wraps it to WETH internally each buy.
const { ethers } = require("ethers");

const ROUTER = process.env.ROUTER || "0xCaf681a66D020601342297493863E78C959E5cb2";
const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const TOKEN_OUT = process.env.TOKEN_OUT || "0x6696FE29288B586017E6f264c0091DBA6C5ebeaf";
const POOL_FEE = Number(process.env.POOL_FEE || 10000);
// A fresh wallet's FIRST buy (creating its ROBIN balance cold) costs ~171k gas;
// warm re-buys are ~129k. Cap generously — you only pay for gas USED, not the limit,
// so a high ceiling never costs more on a successful buy; too LOW a ceiling makes the
// tx run out of gas and revert, which burns the gas for nothing.
const BUY_GAS_LIMIT = BigInt(process.env.BUY_GAS_LIMIT || 200000);

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

function buyParams(recipient, amountIn) {
  return {
    tokenIn: WETH,
    tokenOut: TOKEN_OUT,
    fee: POOL_FEE,
    recipient,
    amountIn,
    amountOutMinimum: 0n, // proven safe: original buys use 0 → no size revert
    sqrtPriceLimitX96: 0n,
  };
}

// A single buy from `wallet`. Legacy (type-0) tx, explicit gasLimit (this chain's
// estimateGas is unreliable), value = amountIn (the router wraps it).
async function buyOnce(wallet, amountIn, gasPrice) {
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  return router.exactInputSingle(buyParams(wallet.address, amountIn), {
    value: amountIn,
    type: 0,
    gasPrice,
    gasLimit: BUY_GAS_LIMIT,
  });
}

// Buy as many times as this wallet can afford at `amountIn`. A wallet funded for
// exactly one buy does one; a wallet with more keeps buying until it can't cover
// (value + gasLimit*gasPrice) anymore. Returns {buys, spentWei}.
async function drainWalletBuys({ wallet, provider, amountIn, gasPrice, maxBuys = 100000, log = () => {} }) {
  const perBuyNeed = BUY_GAS_LIMIT * gasPrice + amountIn; // must be reservable up front
  let buys = 0, spentWei = 0n;
  while (buys < maxBuys) {
    let bal;
    try { bal = await provider.getBalance(wallet.address, "latest"); } catch { break; }
    if (bal < perBuyNeed) break;
    try {
      const tx = await buyOnce(wallet, amountIn, gasPrice);
      const rc = await tx.wait();
      buys++;
      spentWei += amountIn + rc.gasUsed * (rc.gasPrice ?? gasPrice);
    } catch (e) {
      log(`    buy failed ${wallet.address.slice(0, 10)}…: ${e.shortMessage || e.message}`);
      break;
    }
  }
  return { buys, spentWei };
}

module.exports = { buyOnce, drainWalletBuys, buyParams, ROUTER, WETH, TOKEN_OUT, POOL_FEE, BUY_GAS_LIMIT };
