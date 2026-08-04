// Standalone Disperse deployer — NO Hardhat (Hardhat now needs Node 22; this runs on Node 20).
// Self-contained: the compiled bytecode + ABI are embedded, so it needs only ethers (already
// installed in launchpad/node_modules or indexer/node_modules).
//
//   cd /root/sherif/launchpad
//   RPC_URL="$(grep '^RPC_URL=' ../indexer/.env | cut -d= -f2-)" \
//     PRIVATE_KEY=<funded deployer key> \
//     node scripts/deploy-disperse-standalone.js
//
// The RPC MUST be write-capable (your Alchemy endpoint — the indexer's RPC_URL is fine).
// Guards chain 4663, uses a legacy (type-0) tx, deploys the contract (no constructor args),
// and prints the address to drop into pad/assets/config.js. Touches nothing else.
const { ethers } = require("ethers");

const ABI = [
  { "inputs": [], "name": "EmptyList", "type": "error" },
  { "inputs": [], "name": "EthTransferFailed", "type": "error" },
  { "inputs": [], "name": "LengthMismatch", "type": "error" },
  { "inputs": [], "name": "ReentrancyGuardReentrantCall", "type": "error" },
  { "inputs": [{ "internalType": "address", "name": "token", "type": "address" }], "name": "SafeERC20FailedOperation", "type": "error" },
  { "inputs": [], "name": "TooManyRecipients", "type": "error" },
  { "inputs": [], "name": "ValueMismatch", "type": "error" },
  { "inputs": [], "name": "MAX_RECIPIENTS", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
  { "inputs": [{ "internalType": "address[]", "name": "recipients", "type": "address[]" }, { "internalType": "uint256[]", "name": "values", "type": "uint256[]" }], "name": "disperseEther", "outputs": [], "stateMutability": "payable", "type": "function" },
  { "inputs": [{ "internalType": "contract IERC20", "name": "token", "type": "address" }, { "internalType": "address[]", "name": "recipients", "type": "address[]" }, { "internalType": "uint256[]", "name": "values", "type": "uint256[]" }], "name": "disperseToken", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
  { "inputs": [{ "internalType": "contract IERC20", "name": "token", "type": "address" }, { "internalType": "address[]", "name": "recipients", "type": "address[]" }, { "internalType": "uint256[]", "name": "values", "type": "uint256[]" }], "name": "disperseTokenDirect", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
];

// Compiled creation bytecode for launchpad/contracts/Disperse.sol (solc 0.8.24, matches the audited source).
const BYTECODE = "0x6080806040523461003a5760017f9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f005561066a90816100408239f35b600080fdfe60406080815260048036101561001457600080fd5b600091823560e01c8063637f63311461035b578063a6980ce21461033a578063c73a2d60146101ee5763e63d38ed1461004c57600080fd5b806003193601126101ea576001600160401b0382358181116101e6576100759036908501610406565b916024359081116101e25761008d9036908601610406565b610095610557565b8084036101cf5783156101bf5761025884116101af578693875b81811061018f575084341061017f57875b818110610133575050505050803403903482116101205790849134036100f7575b5060016000805160206106158339815191525580f35b81808092335af16101066104f7565b50156101135782816100e1565b51630db2c7f160e31b8152fd5b634e487b7160e01b855260118452602485fd5b8880808061014a61014586888c61049a565b6104c0565b61015586898b61049a565b35905af16101616104f7565b501561016f576001016100c0565b8651630db2c7f160e31b81528890fd5b855163dd8e4af760e01b81528790fd5b946101a86001916101a188868861049a565b35906104d4565b95016100af565b8451635531b49560e01b81528690fd5b84516301857f4f60e61b81528690fd5b84516001621398b960e31b031981528690fd5b8580fd5b8480fd5b8280fd5b50346101ea576101fd3661043b565b95939161020b939193610557565b8681036103275780156103175761025881116103075787805b8282106102ee576102389150303386610587565b875b818110610257578860016000805160206106158339815191525580f35b61026561014582848661049a565b610270828a8861049a565b885163a9059cbb60e01b8c526001600160a01b039283168952903560249081529160208c604481808b5af18c6001809151148216156102d0575b50828b52156102be5750505060010161023a565b635274afe760e01b8252861681890152fd5b8115166102e557873b15153d151616386102aa565b823d8e823e3d90fd5b6102ff6001916101a1848c8a61049a565b910190610224565b8551635531b49560e01b81528590fd5b85516301857f4f60e61b81528590fd5b85516001621398b960e31b031981528590fd5b838234610357578160031936011261035757602090516102588152f35b5080fd5b50346101ea5761036a3661043b565b9295909394610377610557565b8383036103f65782156103e95761025883116103dc575050855b8181106103ae578660016000805160206106158339815191525580f35b806103d66103c2610145600194868b61049a565b6103cd83878961049a565b35903389610587565b01610391565b51635531b49560e01b8152fd5b516301857f4f60e61b8152fd5b516001621398b960e31b03198152fd5b9181601f84011215610436578235916001600160401b038311610436576020808501948460051b01011161043657565b600080fd5b906060600319830112610436576004356001600160a01b038116810361043657916001600160401b0391602435838111610436578261047c91600401610406565b939093926044359182116104365761049691600401610406565b9091565b91908110156104aa5760051b0190565b634e487b7160e01b600052603260045260246000fd5b356001600160a01b03811681036104365790565b919082018092116104e157565b634e487b7160e01b600052601160045260246000fd5b3d15610552576001600160401b03903d82811161053c5760405192601f8201601f19908116603f011684019081118482101761053c5760405282523d6000602084013e565b634e487b7160e01b600052604160045260246000fd5b606090565b60008051602061061583398151915260028154146105755760029055565b604051633ee5aeb560e01b8152600490fd5b6040516323b872dd60e01b60009081526001600160a01b03938416600452938316602452604494909452909160209060648180855af16001600051148116156105f4575b836040526000606052156105de57505050565b635274afe760e01b835216600482015260249150fd5b600181151661060a57813b15153d1516166105cb565b833d6000823e3d90fdfe9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00a2646970667358221220c1c80b61cb8d17d6fd658eba77e47d165b38d3a00c8c1e415c00f5f41b2e6e7d64736f6c63430008180033";

async function main() {
  const rpc = (process.env.RPC_URL || process.env.ROBINHOOD_RPC || "").trim();
  const pkRaw = (process.env.PRIVATE_KEY || "").trim();
  if (!rpc) throw new Error("Set RPC_URL to a WRITE-capable endpoint (your Alchemy RPC — the indexer's RPC_URL works).");
  if (!pkRaw) throw new Error("Set PRIVATE_KEY to a funded deployer key.");
  const pk = pkRaw.startsWith("0x") ? pkRaw : "0x" + pkRaw;

  const provider = new ethers.JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== 4663) throw new Error(`Wrong chain ${net.chainId}, expected 4663. Aborting.`);

  const wallet = new ethers.Wallet(pk, provider);
  let gasPrice = (await provider.getFeeData()).gasPrice;
  if (gasPrice == null) gasPrice = BigInt(await provider.send("eth_gasPrice", []));
  try { const b = await provider.getBlock("latest"); const f = ((b?.baseFeePerGas ?? 0n) * 12n) / 10n; if (f > gasPrice) gasPrice = f; } catch {}

  const bal = await provider.getBalance(wallet.address);
  console.log("Deployer:", wallet.address);
  console.log("Chain:   ", Number(net.chainId), "(Robinhood Chain)");
  console.log("Balance: ", ethers.formatEther(bal), "ETH  | gasPrice", gasPrice.toString());
  if (bal === 0n) throw new Error("Deployer has 0 ETH — fund it first.");

  const factory = new ethers.ContractFactory(ABI, BYTECODE, wallet);
  const c = await factory.deploy({ type: 0, gasPrice });
  const tx = c.deploymentTransaction();
  console.log("\nDeploy tx:", tx.hash, "— waiting for confirmation…");
  await c.waitForDeployment();
  const addr = await c.getAddress();

  // sanity read: MAX_RECIPIENTS() should be 600 if the code is live
  let max = "?";
  try { max = (await c.MAX_RECIPIENTS()).toString(); } catch {}
  console.log("\n✅ Disperse deployed:", addr, "(MAX_RECIPIENTS =", max + ")");
  console.log("\nNext steps:");
  console.log('  1. Set  CONTRACTS.disperse = "' + addr + '"  in pad/assets/config.js');
  console.log("  2. Verify it on Blockscout: robinhoodchain.blockscout.com/address/" + addr + " (or paste the flattened source).");
  console.log("  3. Once config is set, the airdrop page + the dev-buy split card go live.");
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
