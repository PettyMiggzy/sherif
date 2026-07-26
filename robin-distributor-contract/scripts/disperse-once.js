// One-shot: disperse the current funding-wallet balance now (no watching).
//   npm run disperse:once
require("dotenv").config();
const { getProvider, getWallet, getDisperse, loadRecipients, resolveUnitWei } = require("./lib");
const { distributeOnce } = require("./disperse-core");

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const disperse = getDisperse(null, wallet);
  const recipients = loadRecipients();
  const amountEach = await resolveUnitWei();
  await distributeOnce({ provider, wallet, disperse, recipients, amountEach, log: (m) => console.log(m) });
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
