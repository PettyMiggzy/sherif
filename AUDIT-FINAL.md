# Final pre-deploy audit — whole repo

Two questions, not one: **is it safe**, and **is it what was asked for**. The second is where the findings are.

Status: security pass in progress. Requirements pass complete — **2 gaps, both blocking the thing they belong to.**

---

## Part 1 — Requirements traceability

Every decision taken, traced to the code that implements it. "Deploying" means the v2 pad
(`launchpad/`), which is what actually ships next; `pad-v4/` is a separate, later deploy.

| # | what was asked for | in the deploying build? | evidence |
|---|---|---|---|
| 1 | **Coin addresses end in `1ab5`** | ❌ **NO — v4 only** | `pad-v4/contracts/core/PadBrand.sol:22`, called by all three v4 factories. **Nothing in `launchpad/` enforces or can even produce a branded address.** See REQ-1. |
| 2 | **Creators choose their own supply** | ⚠️ **contract yes, UI no** | `CurvePadFactory.launchWithSupply` exists and is tested. But `pad/assets/wallet.js:641` calls `launch()`, the UI ABI (`config.js:136`) has no `launchWithSupply`, there is no supply input, and `create.html:278` still advertises "**1,000,000,000** supply · fixed". **No user can reach the feature.** See REQ-2. |
| 3 | **No dev-buy cap, ever** | ✅ yes | `CurvePadFactory` `_devBuy` — no bps-of-supply term; "no supply cap on the dev buy" x2. Pinned by `test/v2-stack.test.js`. |
| 4 | **No anti-snipe, ever** | ✅ yes | zero `GuardConfig` in `_launch`; `seedBlocklist` removed from the factory. Pinned locally and on a live fork (`curvepad.fork.test.js`). |
| 5 | **Second factory; leave v1 alone** | ✅ yes | `scripts/deploy-v2.js` deploys 2 contracts and reuses the live router/deployers; `DEPLOY-V2.md` explicitly says do **not** call `removeFactory` on v1. |
| 6 | **Deep floor wall (H-5 fix)** | ✅ yes | `BondGeometry.BOUNTY_NEAR = 9000`; measured on a fork against the real `Bond` — live band edge **+0.2299 ETH**, shipped band **−0.0649**. |
| 7 | **No user-added withdrawable LP** | ✅ yes | pages deleted, panel + JS removed, `floorCoopFactory: ""`. Verified on chain `coopCount() == 0` first, so nothing was stranded. |
| 8 | **No untrue advertising** | ✅ yes | floor + guard copy made factory-independent; `95%` qualified with the 10% open fee; promo's flat "0.5 ETH" → "up to" (payout is `min(GRAD_REWARD, raise/4)`). One operational promise left for the owner: the DexScreener boost. |
| 9 | **Fewer RPC calls** | ✅ yes | `grad-keeper.js` — one batched POST per poll, disk-cached coin list, retirement set, 429-aware backoff. |
| 10 | **Canonical repo = `Robinlabz/Labs`** | ✅ yes | every `PettyMiggzy/sherif` mention in the tree is inside the rule text forbidding its use. No leaked references. |

### REQ-1 — the brand suffix is not in the factory that is about to ship. **BLOCKING for that feature.**

You asked to lock the coin address ending in. It exists, is contract-enforced, and is well tested — **in
`pad-v4`, which is not what deploys next.** The v2 pad has no equivalent, and cannot get one without a change:

```solidity
// launchpad/contracts/CurvePadFactory.sol:260 — the salt is built INSIDE the factory
bytes32 salt = keccak256(abi.encodePacked(
    address(this), p.dev, p.name, p.symbol, block.number, block.timestamp, allTokens.length));
```

`block.number`/`block.timestamp` make it deliberately unpredictable, so **it cannot be mined for a suffix**. To
brand v2 the factory has to accept a caller-supplied `tokenSalt` and enforce the suffix before any state write.

**That is safe to do.** The pre-init pool DoS this entropy guards against is already defeated one layer down:
`LaunchTokenDeployer.deploy` folds `msg.sender` into the CREATE2 salt, and its own comment says so — "an
attacker's address differ[s] from the factory's — the collision is gone". The block entropy is belt-and-braces
on a defence that already holds, and Robinhood Chain's single-sequencer FCFS ordering removes the mempool race
that would otherwise make a public mined salt front-runnable.

Cost: a `tokenSalt` param, a `PadBrand`-style mask+compare, and client-side mining (~65k tries, ~2s in plain JS,
far less with a WASM keccak). Decision needed: does the simple `launch()` path also require a mined salt? If the
brand is a rule rather than an option, it must — which means the UI has to mine before every launch.

### REQ-2 — creator-chosen supply is unreachable. **BLOCKING for that feature.**

The contract work is done and fork-tested (a 10,000-token coin launches, trades and graduates on live chain).
None of it is wired up: the UI calls the old `launch()`, does not carry `launchWithSupply` in its ABI, has no
supply or market-cap input, and still tells creators supply is fixed at 1,000,000,000.

Needed: the `launchWithSupply` ABI entry, supply + market-cap inputs (the presets and `launchFieldsFor` helper
already exist in `pad-v4/scripts/valuation.js` and port directly), the realised-market-cap readout, and the
`create.html` copy corrected. Until then item 2 ships as contract capability nobody can use.

---

## Part 2 — Security pass

*(in progress — secrets, custody, frontend fund paths covered; contracts, indexer, suite health pending)*

### Covered so far, no critical findings

- **Secrets** — only `.env.example` files are tracked; `.gitignore` covers `.env` in every subproject; no keys
  in tracked content or in the frontend bundle (the Alchemy key is server-side behind `api.robinlab.io/rpc`).
- **`launchbot` custody** (the highest-risk component in the repo — it holds user private keys): AES-256-GCM,
  scrypt N=2^16 with per-record salt and stored params, random 12-byte IV, auth tag verified, `MASTER_SECRET`
  rejected under 32 chars at boot, keystore written atomically (temp → fsync → rename) at 0600 inside a 0700
  dir, corruption preserved and failed loud rather than silently starting empty. No key export path, no key
  logging, DM-only. `/forget` checks the balance and requires `/forget confirm` with a funds-are-gone warning.
- **Frontend fund paths** — allowance bounded to exactly the sell amount rather than the Trading API's
  `MaxUint256`; `quoteMinOut` slippage guard on both legs.

### SEC-2 — the test suite was not a gate. **FIXED.**

Every test file shares ONE in-process chain (no global fixture) and the sim suites move tens of ETH per case on
top of a 16.7M-gas-per-tx cap. At hardhat's default 10,000 ETH the accounts ran dry partway through a run, and
everything after failed with "sender doesn't have enough funds" — indistinguishable from a regression.

| | passing | failing |
|---|---|---|
| before | 110 | **51** |
| after funding accounts | 189 | **4** |
| after gating the 4 fork-only files | **189** | **0** |

47 of those 51 were an empty wallet. The last 4 (`sim-grad-grief` x2, `trace-curve`, `trace-devbuy`) need a real
Uniswap v3 — `CurvePool.seed` mints a concentrated position the mock cannot — but were not gated behind
`FORK_RPC` the way `test/fork/*` is. All four pass on a fork; they are now gated, so the default run is honest.

This is not cosmetic. A suite failing ~45% of the time for environmental reasons **cannot gate a deploy**,
because a real regression hides in the noise. It can now.

### SEC-3 — the full suite CANNOT be run against a fork of the public node. Shard it.

The public Robinhood RPC is not an archive node (retention measured under 10,000 blocks). A full run takes ~7
minutes, outliving the pinned fork block, and the run **aborts mid-way**:

```
Fatal external error: ... JsonRpcError { code: -32000, message: "metadata is not found, 43402976" }
```

Individual fork files finish inside the window and pass. So CI (and anyone re-verifying this) must run the
non-fork suite as one job and fork files individually or in small groups — never `FORK_RPC=… npx hardhat test`
across everything. Verified green this way: `curvepad.fork` 8, `bond-h5-attack.fork` 5, pad-v4 `test:fork` 4,
plus the three newly-gated files 4.

### SEC-1 — custody is the largest counterparty risk in the product, and no contract can reduce it

Not a bug; a shape. `launchbot` is **fully custodial with no self-custody escape** — a user cannot export their
key. One `MASTER_SECRET` plus one host equals every bot user's funds. For a product whose pitch is that
liquidity *can't be rugged*, the softest point is the part the contracts do not cover. Worth an explicit
decision: accept it, add an export path, or cap what the bot is allowed to hold.
