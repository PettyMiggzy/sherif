const { ethers } = require("hardhat");
const d = require("../../pad/js/deploy.local.json");

async function main() {
  for (const pad of d.pads) {
    const curve = await ethers.getContractAt("RobinCurveV4", pad.curve);
    const tok = await ethers.getContractAt("PadToken", pad.token);
    const stateView = await ethers.getContractAt("RobinStateView", d.contracts.stateView);
    const slot0 = await stateView.getSlot0(pad.poolId);
    console.log(`\n${pad.symbol} (${pad.token})`);
    console.log("  ready:", await curve.ready(), " graduated:", await curve.graduated());
    console.log("  tick:", slot0[1].toString());
    console.log("  buyer1 bal:", (await tok.balanceOf(d.accounts.buyer1)).toString());
    console.log("  buyer2 bal:", (await tok.balanceOf(d.accounts.buyer2)).toString());
    console.log("  buyer3 bal:", (await tok.balanceOf(d.accounts.buyer3)).toString());
  }
  console.log("\npoolManager ETH balance:", (await ethers.provider.getBalance(d.contracts.poolManager)).toString());
}
main().catch(console.error);
