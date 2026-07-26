require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // Local in-process EVM for tests.
    hardhat: {},
    // Robinhood Chain (chainId 4663). Legacy gas — the deploy/ops scripts send
    // type-0 txs explicitly (see scripts/lib.js). Fill RPC + PRIVATE_KEY via .env.
    robinhood: {
      url: process.env.ROBINHOOD_RPC || "https://robinhoodchain.blockscout.com/api/eth-rpc",
      chainId: 4663,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
