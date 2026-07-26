// Auto-watcher: polls your funding wallet and, whenever Robinhood ETH lands,
// disperses a fixed $0.0000814 to each recipient (one tx when the wallets exist),
// gas pinned to baseFee. Runs forever — put it behind systemd/pm2 on your droplet.
//   npm run watch
require("dotenv").config();
const { getProvider, getWallet, getDisperse, loadRecipients, safeGetBalance, resolveUnitWei, ethers, CHAIN } = require("./lib");
const { distributeOnce } = require("./disperse-core");

const POLL_MS = Number(process.env.POLL_MS || 15000);
const MIN_DEPOSIT = BigInt(process.env.MIN_DEPOSIT_WEI || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const disperse = getDisperse(null, wallet);
  const recipients = loadRecipients();

  log(`Watching ${wallet.address} on ${CHAIN.name}`);
  log(`Disperse ${await disperse.getAddress()} · ${recipients.length} recipients · poll ${POLL_MS}ms · Ctrl-C to stop\n`);

  let last = -1n;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const balance = await safeGetBalance(provider, wallet.address);
      const grew = last < 0n ? balance > 0n : balance > last;
      if (grew && balance > 0n && balance >= MIN_DEPOSIT) {
        const mode = (process.env.DISPERSE_MODE || "fixed").toLowerCase();
        const amountEach = mode === "even" ? 0n : await resolveUnitWei(); // price only needed for fixed
        log(`\n[${new Date().toISOString()}] +funds → balance ${ethers.formatEther(balance)} ETH`);
        await distributeOnce({ provider, wallet, disperse, recipients, amountEach, log });
        last = await safeGetBalance(provider, wallet.address);
      } else {
        last = balance;
      }
    } catch (e) {
      console.error(`watch error: ${e.shortMessage || e.message}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
