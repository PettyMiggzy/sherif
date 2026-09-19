require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// 10,000,000 ETH per test signer. Every test file shares ONE in-process chain, and the sim/regression suites
// move thousands of ETH per case; at hardhat's default 10,000 ETH the shared signers run dry partway through a
// full combined run and everything after fails with "sender doesn't have enough funds" — failures that read as
// regressions but are just an empty wallet. This is the caveat AUDIT-ROUND-4-BRIEF documented; fund the signers
// past anything the suite can spend so a red test means a real red test. Mirrors launchpad/hardhat.config.js.
const ACCOUNTS_BALANCE = (10_000_000n * 10n ** 18n).toString();

// Robin V4 "pad of pads" — compiler pinned to match the live PoolManager
// (0x8366a39CC670B4001A1121B8F6A443A643e40951): solc 0.8.26, viaIR, optimizer runs 1.
// Never change these without re-checking hook-address mining (the mined salt depends
// on the exact init-code hash, which depends on the compiler + settings).
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    // FORK_RPC set → in-process hardhat forks Robinhood Chain so tests run against the
    // REAL v4 PoolManager 0x8366. Never commit the key: FORK_RPC=<url> npx hardhat test test/fork/*.js
    // FORK_BLOCK pins the forked block. The public RPC is NOT an archive node, so a long fork run can outlive
    // its state-retention window and abort mid-suite with "historical state ... is not available". Pin a recent
    // block (and point FORK_RPC at an archive node for older ones) when running the whole fork suite at once.
    hardhat: process.env.FORK_RPC
      ? {
          forking: {
            url: process.env.FORK_RPC,
            ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
          },
          chainId: Number(process.env.FORK_CHAINID || 4663),
          hardfork: "cancun",
          // EDR needs the hardfork for historical blocks on these non-standard chains; both Robinhood
          // mainnet (4663) and testnet (46630) are Cancun from genesis. Without this, forking a testnet
          // block fails with "No known hardfork for execution on historical block".
          chains: {
            4663: { hardforkHistory: { cancun: 0 } },
            46630: { hardforkHistory: { cancun: 0 } },
          },
          accounts: { accountsBalance: ACCOUNTS_BALANCE },
        }
      : { accounts: { accountsBalance: ACCOUNTS_BALANCE } },
    robinhood: {
      url: process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      // Robinhood Chain (Orbit) has NO EIP-1559. Deploy scripts must send legacy type-0
      // txs with an explicit gasPrice; hardhat-ethers reads this hint but scripts set it too.
      gasPrice: 30_180_000,
    },
    // Testnet (chainId 46630). Fund a hot deployer at faucet.testnet.chain.robinhood.com, then:
    //   POSITION_MANAGER=<testnet v4 posm> npx hardhat run scripts/deploy-curve.js --network robinhoodTestnet
    robinhoodTestnet: {
      url: process.env.TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 30_180_000,
    },
  },
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
  // [brand] Launch tests now MINE a `faf0` token address (PadBrand.requireBrand), ~65k keccak tries (~2s) per
  // distinct pad config — and a stock pad mines against two constraints at once. Mocha's 40s default is too
  // tight for the suites that launch several pads in one test.
  // [MERGE] Raised from 180s. H2.stock-gate takes ~2 min in ISOLATION (it mines branded stock-pad addresses
  // under two constraints), which left almost no headroom; under a full combined run it tipped over and failed
  // as a timeout rather than on its own merits. The [H-5] observation ring also adds real per-swap cost, and
  // the full suite went from ~26 to ~41 minutes with it — so the margin shrank exactly where it was thinnest.
  // Overridable via MOCHA_TIMEOUT, same convention as launchpad.
  mocha: { timeout: Number(process.env.MOCHA_TIMEOUT || 600000) },
};
