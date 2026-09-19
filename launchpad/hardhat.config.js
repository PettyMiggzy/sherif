require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // loads FORK_RPC / ROBINHOOD_RPC / PRIVATE_KEY from .env (gitignored)

// 10,000,000 ETH per test signer — see `accountsBalance` note in `networks.hardhat` below.
const ACCOUNTS_BALANCE = (10_000_000n * 10n ** 18n).toString();

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
    //
    // accountsBalance: `npx hardhat test` runs every file against ONE in-process chain, so
    // signer balances carry across files. The sim/trace suites move 100-200 ETH per case, which
    // drains hardhat's default 10,000 ETH faucet part-way through the run and fails the rest of
    // the suite with "Sender doesn't have enough funds". 10,000,000 ETH per account is ~1000x
    // the whole suite's throughput. Deploy networks are unaffected (real accounts, real balances).
    // FORK_BLOCK pins the forked block. Robinhood Chain's public RPC is NOT an archive node, so a long fork
    // run outlives its state-retention window and dies mid-suite with "historical state ... is not available".
    // Pin a recent block (and use an archive RPC for older ones) when running the whole fork suite at once.
    hardhat: process.env.FORK_RPC
      ? {
          forking: {
            url: process.env.FORK_RPC,
            ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
          },
          chainId: 4663,
          accounts: { accountsBalance: ACCOUNTS_BALANCE },
        }
      : { accounts: { accountsBalance: ACCOUNTS_BALANCE } },
    // Robinhood Chain (fill RPC + PRIVATE_KEY via env before deploying)
    robinhood: {
      // The canonical chain RPC. NOT the Blockscout proxy: that endpoint sits behind a Cloudflare
      // challenge and answers 403 to programmatic clients (verified), so it cannot serve a deploy.
      url: process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com",
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
