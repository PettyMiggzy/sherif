# JavaScript SDK

`@robinlabs/pad-sdk` is a tiny, **read-only** package that lets you import the pad's data with one line — live [addresses](network.md), typed ABIs, and two clients. It signs nothing and holds no keys.

- **`RobinLabsAPI`** — the [indexer](api.md)'s fast JSON feed (browse, trades, stats, rewards). Uses `fetch` only, so it runs anywhere.
- **`RobinLabsChain`** — direct on-chain reads with no indexer at all. You pass in ethers v6 + a provider.

```bash
npm i @robinlabs/pad-sdk ethers   # ethers is an optional peer — only the chain client needs it
```

It's a single dependency-free file (`sdk/robinlabs.mjs`), so you can also just drop it into a project and `import` it.

## Import feed data (indexer API)

The API is built to scale — the feed is served from precomputed snapshots, so a page listing thousands of coins costs **one** request and **zero** per-coin RPC calls.

```js
import { RobinLabsAPI } from "@robinlabs/pad-sdk";

const api = new RobinLabsAPI("https://your-indexer-host");   // self-host: see the API page
const { items } = await api.coins({ sort: "trending", filter: "live", limit: 60 });
const coin      = await api.coin(items[0].token);            // enriched: progress, mcap, volume
const trades    = await api.trades(items[0].token);          // exact-wei recent trades
const totals    = await api.stats();                         // coins, graduated, 24h volume
const rewards   = await api.rewards("0xWallet…");            // claimable (with proofs) + pending
```

> No indexer host of your own? The pad reads the chain directly as a fallback, and so can you — use the chain client below. Run your own indexer with the [Self-hosting](api.md) steps.

## Read on-chain (no indexer)

Works against the public RPC with nothing but ethers. Every method is a read.

```js
import { ethers } from "ethers";
import { RobinLabsChain, CHAIN, ADDRESSES } from "@robinlabs/pad-sdk";

const provider = new ethers.JsonRpcProvider(CHAIN.rpc);
const pad = new RobinLabsChain({ ethers, provider });

const n     = await pad.tokenCount();     // coins launched so far
const token = await pad.tokenAt(n - 1n);  // most recent coin
const cfg   = await pad.config(token);    // fee bps, pool, curve, projectWallet
const esc   = await pad.devEscrow(token); // creator's uncollected sell fees (wei)
const bond  = await pad.bond(token);      // 0x0 until graduated
const coop  = await pad.coop(token);      // per-coin FloorCoop LP vault (0x0 if none)

// live launch feed — cb fires on every new coin; call the returned fn to unsubscribe
const off = pad.onLaunch(({ token, curve, pool, dev }) => console.log("new coin", token));
```

## Exports

| Export | What |
|--------|------|
| `CHAIN` | `{ id: 4663, hex, name, rpc, explorer, perTxGasCap }` |
| `ADDRESSES` | The live, source-verified stack (factory, router, rewardVault, floorCoopFactory, splitter, WETH, v3 factory) |
| `ABI` | Human-readable ABIs: `factory`, `router`, `floorCoopFactory`, `erc20` (ethers parses directly) |
| `explorerUrl(addr)` | Blockscout address link |
| `RobinLabsAPI` / `RobinLabsChain` | The two read clients above |

Everything is source-verified on [Blockscout](https://robinhoodchain.blockscout.com) and [Sourcify](https://sourcify.dev) (chain `4663`), so you can also pull ABIs straight from the explorer. For **write** flows (launch, buy, sell, graduate, dev controls) see the [Integration Guide](integration.md); for the raw contract reference see [Contracts & ABI](contracts.md).
