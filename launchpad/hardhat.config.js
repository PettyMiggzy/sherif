require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // loads FORK_RPC / ROBINHOOD_RPC / PRIVATE_KEY from .env (gitignored)

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
    },
  },
  networks: {
    // When FORK_RPC is set, the in-process hardhat network forks Robinhood Chain so tests
    // run against the REAL Uniswap v3 factory + WETH (not the mock). Never commit the key —
    // pass it via env: `FORK_RPC=<alchemy url> npx hardhat test test/fork/*.js`.
    hardhat: process.env.FORK_RPC
      ? {
          // Every test file shares ONE in-process chain (there is no global fixture), and the sim//fork suites
          // move tens of ETH per case on top of a 16.7M-gas cap per tx. At hardhat's default 10,000 ETH the
          // accounts run dry partway through a full run and everything after fails with "sender doesn't have
          // enough funds" — failures that look like regressions but are just an empty wallet. Fund them far
          // past anything the suite can spend so a red test means a real red test.
          accounts: { accountsBalance: "100000000000000000000000000" }, // 1e8 ETH
          forking: {
            url: process.env.FORK_RPC,
            // FORK_BLOCK pins the fork so hardhat caches state on disk per (url, blockNumber) instead of
            // re-fetching everything from the RPC on every run. It is OFF by default because the public
            // Robinhood node is NOT an archive node: measured retention is under 10,000 blocks (~100s at the
            // chain's ~100ms block time), so any pinned constant goes stale within minutes and every run then
            // fails with `metadata is not found`. Set FORK_BLOCK only when pointing FORK_RPC at an archive
            // node — then repeat runs cost ~no network at all.
            ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
          },
          chainId: 4663,
        }
      : { accounts: { accountsBalance: "100000000000000000000000000" } }, // same, for the non-fork run
    // Robinhood Chain (fill RPC + PRIVATE_KEY via env before deploying)
    robinhood: {
      url: process.env.ROBINHOOD_RPC || "https://robinhoodchain.blockscout.com/api/eth-rpc",
      chainId: 4663,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  // Blockscout source verification (needed before the explorer shows Read/Write, name tags, etc.).
  // Blockscout uses an Etherscan-compatible API and ignores the key, so any non-empty string works.
  etherscan: {
    apiKey: { robinhood: process.env.BLOCKSCOUT_KEY || "blockscout" },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
