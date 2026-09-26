# Robin Labs Pad

A permissionless token launchpad on **Robinhood Chain**, quoted in **USDG**.
Every launch is a **real Uniswap v4 pool from block one**: no bonding curve,
no graduation event, no migration, no market-cap cliff. See `src/` for the
contracts and `test/RobinPad.t.sol` for the full lifecycle, tested end to end
against a real `PoolManager` and a real swap router (no mocks of Uniswap's
own contracts). `test/ForkRobinhood.t.sol` runs the whole stack on real
Robinhood Chain state with real USDG.

**Live on Robinhood Chain mainnet since 2026-09-26.** The house pad is
`0x923c4443fd996c757646A9753D89F57913aBEe71`. All addresses are listed in
[docs/ROBINHOOD-DEPLOY.md](docs/ROBINHOOD-DEPLOY.md#deployed-on-mainnet), which also covers how to deploy.

**Where this code came from.** It was ported on 2026-09-26 from the
`launchpad/` package in `PettyMiggzy/tr`, where it was built and audited for
another chain. The port changed no contract logic. It renamed the contracts
(see the table below), swapped the quote asset to USDG, rewrote the deploy
script for a fresh Robinhood deploy, and replaced the fork tests. Renaming
changed no compiled bytecode: every contract builds to the same bytes as the
audited source.

**It was externally audited before the port (Fable, 2026-09-22 and
2026-09-24) and fixed:** 3 HIGH, 4 MEDIUM, 8 LOW findings, all addressed.
The report is `docs/AUDIT-2026-09-24.md`. It predates the rename, so it uses
the original contract names:

| name in the audit report | name here |
|---|---|
| `TrollHook` | `RobinHook` |
| `TrollPortal` | `RobinPortal` |
| `TrollPadFactory` | `RobinPadFactory` |
| `TrollTreasury` | `RobinTreasury` |
| `TrollLocker` | `RobinLocker` |
| `TrollLaunchToken` | `RobinLaunchToken` |
| `TrollRevenueSplitter` | `RobinRevenueSplitter` |
| `TrollHolderToken` | `RobinHolderToken` |
| `ITrollSplitter` | `IRobinSplitter` |

The short version of the audit's outcome runs through this file: tax is
always taken in the quote asset (never the launch token), swaps never make
an external token transfer (a frozen treasury or splitter can only ever
block its own claim, never a swap), and pool creation is gated to
authorized portals only.

## How a launch works

1. **`RobinPortal.createLaunch(...)`** — permissionless, one transaction.
   - Mints the full 1,000,000,000-token supply straight to the Portal.
   - Deploys the launch's revenue splitter (`RobinRevenueSplitter`).
   - Picks the pool's opening price from the creator's chosen
     `startingMarketCapQuote` (e.g. $500) — `IPoolManager.initialize` sets
     a pool's starting price for **free**, completely independent of how
     much liquidity is then deposited, so no real capital is ever required
     to open at a meaningful price.
   - Deploys this launch's `RobinLocker`, transfers the full token supply
     to it, and seeds a **single-sided concentrated position** — pure
     launch token, resting entirely above (or below, depending on
     token/quote address ordering) the opening price. No quote asset is
     ever collected to do this.
   - Registers the pool with the shared `RobinHook` and authorizes both
     the hook and the Locker to deposit revenue into the splitter.
2. **Trading happens on the real pool from that instant on** — the
   "curve" is just the pool's own natural price-impact at low depth, the
   same math any AMM position has, no custom contract needed to fake it.
   As real buyers push USDG in, the position naturally shifts from 100%
   launch-token composition toward a mix of both currencies, which is what
   makes selling possible (see "No bid-side liquidity at launch" below).
3. **The platform's cut of everything** — the shared hook's swap tax, and
   LP fees harvested from the launch's own locked position — is **10% on
   the main pad, 15% on every white-label pad** (the extra 5% covers
   hosting the white-label frontend, a real cost only white-label pads
   create). The creator gets the rest: a **full, undiluted 90% (or 85%)**,
   credited to a claimable balance, no further subdivision. Both sides are
   pull-based: the creator calls `RobinRevenueSplitter.claim`, and anyone
   can call `claimPlatform` to move the platform's cut into `RobinTreasury`
   (shared across every pad) — see "No automated buyback" below for what
   happens to it from there. Pull-based on both sides, on purpose (see
   "Revenue never moves during a swap" below) — a broken or blocklisted
   recipient can only ever block its own claim.

## No bid-side liquidity at launch — by design, not a bug

Right after a launch, the position is 100% launch token (an "ask wall")
— **nobody can sell yet**, because zero real quote asset was ever
deposited to sell into. This is the direct, honest consequence of
requiring zero real capital to launch: there's no phantom backing the way
a virtual-reserve curve fakes a starting price, so there's genuinely
nothing to sell into until a real buyer creates some. The moment a buy
happens, the position accumulates real quote-asset backing within its
range, and selling (back into that same range) becomes possible. Verified
directly in `test_SellWorksOnlyAfterABuyCreatesBidSideDepth`.

## No automated buyback-and-burn

An earlier version of this repo auto-swapped the platform's cut for
$ROBIN and burned it on every single deposit, with its own no-keeper
trigger mechanism, slippage protection, and a dependency on the chain's
UniversalRouter/Permit2/StateView addresses being exactly right. All of
that is gone. `RobinTreasury` is now genuinely simple: it receives USDG,
and its `owner` can `withdraw` it. Nothing else. No swap logic, no price
reads, no automatic trigger of any kind — what happens to the accumulated
platform cut (buying back $ROBIN, or anything else) is a deliberate,
manual decision, on whatever cadence the owner wants. If holders of a
launched token want to burn their own tokens, they can already do that
themselves; nothing here needs to do it for them.

## Creator-controlled tax — always denominated in quote

`buyTaxBps` / `sellTaxBps` are set by the creator at launch time (0–10%
per side, `RobinPortal.MAX_TAX_BPS` enforces the cap), immutable
afterward — the rate can never change out from under a trader. The shared
`RobinHook` taxes every swap on every launch's pool, and — post audit fix,
see below — the tax is **always taken in the pool's quote asset, on both
buy and sell, never in the launch token**:
- Quote as the swap's *specified* leg (exact-in buy, exact-out sell) is
  taxed in `beforeSwap`, via the returned `BeforeSwapDelta` shrinking the
  amount that actually reaches the pool's swap math.
- Quote as the swap's *unspecified* leg (exact-in sell, exact-out buy) is
  taxed in `afterSwap`, from the realized swap delta.

Exactly one of the two fires per swap, so every swap shape is taxed
exactly once. An earlier version of this hook taxed whichever currency was
"unspecified" regardless of which one was quote — which meant an ordinary
exact-input buy (what every router sends by default) was taxed in the
launch token instead of quote, handing the creator a claimable, dumpable
cut of the tokens bought on every single buy. A real, external audit
(Fable, see `docs/AUDIT-2026-09-24.md`) caught this as
its top finding; fixed and covered by
`test_BuyAndSellTaxAreBothAlwaysInQuoteNeverInLaunchToken`.

### Revenue never moves during a swap

Tax is never transferred to anyone mid-swap. It's minted to the hook as
ERC-6909 claims on the `PoolManager` (tracked per pool in `pendingTax`),
and paid out through a permissionless `flush(key)` anyone can call at any
time — no keeper, just a cron job or a curious trader. This exists because
the ORIGINAL version pushed tax straight to the splitter, which pushed the
platform's cut on to the treasury, **inside the swap itself** — meaning a
single blocklisted address anywhere in that chain (a regulated stablecoin like
USDG can freeze addresses; the issuer freezing the treasury would be enough)
would have permanently reverted every swap on every pool forever, since
`PoolConfig` is immutable with no way to route around a stuck recipient
mid-swap. `RobinRevenueSplitter`'s own two claim functions (`claim` for
the creator, `claimPlatform` for the treasury) are pull-based for the same
reason: a broken or blocklisted recipient can only ever block its own
claim, never a swap, never `flush`, never the other side's funds. See
`test_BlockedTreasuryCannotBrickSwapsOnlyItsOwnClaim`.

One easy-to-miss but load-bearing detail: the hook's address needs
`Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG` and `Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG`
set, not just `BEFORE_SWAP_FLAG` / `AFTER_SWAP_FLAG` (plus
`BEFORE_INITIALIZE_FLAG` — see "Pool creation is gated" below). The hook
mints/takes/burns ERC-6909 claims and reports the result as a returned
delta so `PoolManager` can credit the hook's own account back to zero (see
`PoolManager.swap`'s `_accountPoolBalanceDelta` call). Without those flag
bits, a returned delta is silently ignored and **every real swap reverts
with `CurrencyNotSettled()`** — a real bug this rewrite's own test suite
caught early on by actually swapping through a live pool, which the old
curve-based design's tests never did (its `buy`/`sell` were plain ERC-20
transfers, never real Uniswap swaps). Required flags, mine for exactly
these (value `0x28CC`): `BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY |
BEFORE_SWAP | AFTER_SWAP | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA`.

### 2026-09-24 audit fixes (in source, covered by `test/AuditFixes.t.sol`)

- **Only a launch's own locker can add liquidity** (`BEFORE_ADD_LIQUIDITY`,
  `hook-1`). Before, anyone could place a one-sided range just past the
  price. That is a limit order other people's swaps fill, and it traded
  with no tax at all while taking a cut of the LP fees. The portal now
  registers the pool, and with it the locker, *before* the locker seeds.
- **A taxed swap must fill in full** (`hook-2`). Tax on the quote-specified
  leg is charged up front, so a swap stopped early by a price limit would
  have been taxed on the part that never traded. Now it reverts with
  `PartialFillUnsupported`. A limit of 0 through the router always fills.
- **Exact-output swaps pay the same rate** (`hook-3`). Their tax is grossed
  up (`ceil(net·t/(1−t))`), so it is `t` of the gross, not `t/(1+t)`.
- **No free price pushes** (`portal-1`). A swap that fills nothing reverts
  with `NoLiquidityToFill`. Before, such a swap moved `slot0` across the
  empty side for free.
- **The pool opens exactly at the position's edge** (`portal-1/2`). Before,
  it opened up to one tick spacing short of the edge. The first buyer
  crossed that gap for free but paid up to ~2% over the advertised price.
- **The factory slot is validated and can be closed** (`factory-trust-1/2`).
  `bootstrapFactory` requires a deployed factory wired to this hook and
  this PoolManager. `renounceFactoryBootstrap` closes the slot for good.
  `script/DeployRobinhood.s.sol` fills both hook slots in the same broadcast
  as the hook, so there is no window where the bootstrapper key could name
  its own factory or portal.
  `RobinPadFactory` rejects zero addresses, a hook on another PoolManager,
  and fees in the wrong decimals.
- **A pool is registered only by the portal that initialized it**
  (`factory-trust-1`). `initializer[id]` is recorded in `beforeInitialize`.
- **Stray USDG in a splitter is recoverable** (`splitter-treasury-3`).
  `sweepSurplus(asset)` credits it through the normal split, and
  `claim(to = splitter)` is rejected.

No trading restrictions, by design (no anti-snipe, max-buy, cooldown,
blacklist or pause: the things token scanners flag).
`test_NoTradingRestrictions_*` asserts that a launch-block buy, a sell-all
and a free transfer all work. `test/ForkRobinhood.t.sol` runs the full
launch lifecycle on a real Robinhood Chain fork when `ROBINHOOD_FORK_URL` is
set. Deploy runbook: `docs/ROBINHOOD-DEPLOY.md`. Source verification:
`script/verify.sh`.

Every fix was mutation-checked. Reverting any one of them makes at least
one test in `test/AuditFixes.t.sol` fail. That file also asserts exact tax
amounts for all four swap shapes in both token orientations (`tests-spec-6`).

### Pool creation is gated to authorized portals

`beforeInitialize` reverts unless the caller is an authorized portal. A
launch's token address is predictable ahead of time (the Portal's own
CREATE nonce), so without this gate anyone could initialize that exact
pool key themselves first and permanently block the real `createLaunch`
with `PoolAlreadyInitialized` — another audit finding, covered by
`test_PreInitializeGriefingByNonPortalIsBlocked`.

## Why a shared hook, not one hook per launch

Uniswap v4 requires a hook's contract address to have specific bits set,
which normally means mining a CREATE2 salt per deployment. That's fine
when it happens in a deploy script, but a customer paying to spin up their
own white-label pad in one click has no such step available. So there's
exactly ONE `RobinHook` instance — for every pad, not just the original —
mined once via Uniswap's own `HookMiner` library (see
`script/RobinhoodStack.sol` and `test/RobinPad.t.sol`'s `setUp()`; no
`vm.ffi`, no external process — pure Solidity, run as part of the script's
own simulation), and every launch's pool, from any pad, registers its own
tax config into it via a mapping keyed by `poolId`.

## RobinPadFactory — "give everybody a launchpad"

`RobinPadFactory.deployPad(label)` is permissionless: pay the flat setup
fee (in USDG, forwarded straight to the shared `RobinTreasury` — same
destination as every dollar of ongoing revenue), get your own
`RobinPortal` in the same transaction. A white-label pad is NOT separate
contract logic — it's the exact same `RobinPortal`/`RobinHook`/
`RobinLocker`/`RobinRevenueSplitter` code, just a new Portal instance
wired into the same shared hook and the same shared treasury. Verified in
`test_Pad_RevenueSplitsFifteenToRobinPadOwnerShareRestToCreator` — a customer's pad launches a
token straight into a real pool on the same shared hook the main pad
uses, with zero collision between the two pads' pools, and its revenue
correctly splits at the white-label 15/85 rate, not the main pad's 10/90.

The hook trusts the factory via a one-time `bootstrapFactory` call (same
pattern as `bootstrapMainPortal` for the original pad). After that, the
factory can authorize as many customer portals as it deploys, forever,
with zero further admin calls. `bootstrapFactory` checks that the factory
is wired to this hook and PoolManager. The deploy script calls it (or
`renounceFactoryBootstrap`) in the same broadcast as the hook.

## Setup

```
bash script/setup-deps.sh   # fetches lib/ (v4-core, v4-periphery, OpenZeppelin, forge-std)
forge build
forge test -vv
```

Dependency versions are pinned exactly in `foundry.lock` (OpenZeppelin
v5.7.0, Uniswap v4-core v4.0.0, v4-periphery at a specific commit) — this
is the exact dependency set the test suite was verified against. `lib/`
itself isn't included in a source-only package like this one, since it's
~95MB of other projects' code; `script/setup-deps.sh` clones each
dependency directly at its pinned commit instead of relying on
`forge install`/git submodules, which need real submodule registration
(`git submodule add`) to work — a plain checkout of this source tree
doesn't have that, only the `.gitmodules` file for reference.

## Not built here yet

- **The website.** These are the contracts only. The upstream frontend has
  not been ported or reskinned for Robin Labs yet.
- **A complete security audit.** The pre-port pass (Fable, 2026-09-22 and
  2026-09-24) found and got fixed 3 HIGH / 4 MEDIUM / 8 LOW findings; see
  `docs/AUDIT-2026-09-24.md` and the sections above. That pass is not
  necessarily final. Treat this as materially safer than the pre-audit
  version, not as a substitute for a complete, final review before real
  funds are at risk.

## White-label pads (PadPortal, PadRevenueSplitter, RobinPadFactory)

Anyone can buy their own launchpad from `RobinPadFactory` for $100. It
plugs into the same shared hook as the main pad. On a pad, Robin Labs takes a
fixed 15% of every launch's revenue (tax plus the USDG-side LP fee), the
pad owner sets their share from 0 to 85%, and the creator gets the rest.
Each launch's split is locked when it launches, and the creator splits
their share across up to 5 payout wallets plus buyback & burn. Pad owners
can also charge a launch fee of up to $1,000, split the same way, and set
the range of starting market caps creators may pick (Robin Labs Pad: $100 to
$10k). A pad
launches tokens exactly the way the main portal does, with the same token,
pool, lock and no trading restrictions. The factory owner can open house
pads (Robin Labs takes 10%); the new Robin Labs Pad is one.

**Templates.** The hook accepts exactly one factory, forever, so the
factory builds pads through templates (`IPadTemplate`). Template #1,
`PadPortalTemplate`, is created by the factory's constructor and builds
every standard pad. The owner can approve more templates later (another
quote asset, another launch token) without a new hook. The factory checks
each new pad is on its hook, PoolManager and treasury, charges Robin Labs'
share and is owned by the buyer before authorizing it.

**Holder dividends (template #2, the house pad's template).** A creator can
give holders a share of their revenue: `createLaunchWithHolders` adds the
launch token itself as the last payout wallet. What lands there is shared
out by `distribute()` pro rata to balances, and each holder claims their own
USDG with `claim()`. The pool, the locker and the burn address never earn.
Earnings stay with the wallet that earned them when it sells or transfers,
and new buyers never receive dividends from before they bought
(`test/HolderPad.t.sol`, `test/HolderToken.t.sol`). Plain launches still
work on the same pad.

`script/DeployRobinhood.s.sol` deploys the factory, approves the holders
template and opens the Robin Labs Pad as a house pad built from it.
