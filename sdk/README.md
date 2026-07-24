# @robinlabs/pad-sdk

Read the [Robin Labs Pad](https://robinlabs.io) with one import — live addresses,
typed ABIs, and two read clients. **Read-only; it signs nothing.**

- `RobinLabsAPI` — the indexer's fast JSON feed (browse, trades, stats). `fetch` only.
- `RobinLabsChain` — direct on-chain reads (no indexer needed). Pass ethers v6 + a provider.
- `legacyOverrides(provider)` — the one helper writes need (Robinhood Chain has no EIP-1559).

## Install

```bash
npm i @robinlabs/pad-sdk ethers   # ethers is an optional peer (only the chain client needs it)
```

Or just drop `robinlabs.mjs` into your project and import it — it's a single dependency-free file
(except the ethers peer for on-chain reads).

## Import feed data (indexer API)

```js
import { RobinLabsAPI } from "@robinlabs/pad-sdk";

const api = new RobinLabsAPI("https://your-indexer-host");   // see docs/api.md to self-host
const { items } = await api.coins({ sort: "trending", filter: "live", limit: 60 });
const one       = await api.coin(items[0].token);            // enriched: progress, mcap, volume
const trades    = await api.trades(items[0].token);          // exact-wei recent trades
const totals    = await api.stats();                         // coins, graduated, 24h volume
```

## Read on-chain (no indexer)

```js
import { ethers } from "ethers";
import { RobinLabsChain, CHAIN, ADDRESSES } from "@robinlabs/pad-sdk";

const provider = new ethers.JsonRpcProvider(CHAIN.rpc);
const pad = new RobinLabsChain({ ethers, provider });

const n     = await pad.tokenCount();          // how many coins launched
const token = await pad.tokenAt(n - 1n);       // most recent
const cfg   = await pad.config(token);         // fee bps, pool, curve, projectWallet
const bond  = await pad.bond(token);           // 0x0 until graduated
const coop  = await pad.coop(token);           // per-coin FloorCoop LP vault (0x0 if none)

// live launch feed
const off = pad.onLaunch(({ token, curve, pool, dev }) => console.log("new coin", token));
// off() to unsubscribe
```

## Trade from a bot (write)

The clients are read-only, but the SDK ships the addresses, the router ABI, and the one override every
write needs. Bring your own signer — the SDK never touches your keys.

```js
import { ethers } from "ethers";
import { ADDRESSES, ABI, CHAIN, legacyOverrides } from "@robinlabs/pad-sdk";

const wallet = new ethers.Wallet(process.env.PK, new ethers.JsonRpcProvider(CHAIN.rpc));
const router = new ethers.Contract(ADDRESSES.padRouter, ABI.router, wallet);

const value  = ethers.parseEther("0.1");
const quoted = await router.buy.staticCall(token, 0n, { value });
await (await router.buy(token, quoted * 99n / 100n, { value, ...(await legacyOverrides(wallet.provider)) })).wait();
```

`legacyOverrides(provider)` → `{ type: 0, gasPrice }` is **required on every write** — Robinhood Chain has
no EIP-1559, so a default type-2 tx is rejected with `-32601`.

## Also exported

`CHAIN` (id 4663, rpc, explorer), `ADDRESSES` (the live verified stack), `ABI`
(human-readable factory / router / floorCoopFactory / erc20), `legacyOverrides(provider)`, and `explorerUrl(addr)`.

Every contract is source-verified on [Blockscout](https://robinhoodchain.blockscout.com)
and [Sourcify](https://sourcify.dev) — you can also pull ABIs straight from the explorer.

See the full [docs](https://robinlabs.io/docs) for the contract reference and write flows.
