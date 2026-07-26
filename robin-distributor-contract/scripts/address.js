// Print the funding wallet address (send Robinhood ETH here) + its balance.
//   npm run address
require("dotenv").config();
const { getProvider, getWallet, safeGetBalance, ethers, CHAIN } = require("./lib");

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const bal = await safeGetBalance(provider, wallet.address);
  console.log(`Funding address : ${wallet.address}`);
  console.log(`Balance         : ${ethers.formatEther(bal)} ETH`);
  console.log(`Explorer        : ${CHAIN.explorer}/address/${wallet.address}`);
  console.log(`\nSend the Robinhood ETH you want to distribute to the address above.`);
}
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
