# Pad Factory: "a pad that launches pads" — plan (draft, 2026-09-25)

Status (2026-09-25, later): **v2 built and tested, not deployed.** The
owner said "go": real fee allocation and extra pad-owner controls, plus
**redeploying Troll Pad itself through the factory** so its sliders work
too. See "v2" below. The owner's wallet runs `script/DeployPadFactory.s.sol`
(`--slow`); nothing is deployed by us.

## Domain and look (owner, 2026-09-25): trollsfactory.com, not trollpad.co

- **trollsfactory.com** is the factory's own site: the "launch your pad"
  signup and the pad owner dashboard. Every pad gets a subdomain,
  `name.trollsfactory.com`. **trollpad.co stays Troll Pad only.**
- Pads are **copies of Troll Pad's site**: the same pages and trading.
  Each pad owner uploads their own imagery (logo, banner, colours) so it
  looks like their own.
- trollsfactory.com was bought at GoDaddy (nameservers
  `ns29/ns30.domaincontrol.com`). Checked 2026-09-25: it shows GoDaddy
  parking (A records `3.33.130.190`, `15.197.148.33`), has no MX or TXT
  records, and isn't in Vercel yet (no domain entry and no project).
  Pointing its nameservers at Vercel (`ns1/ns2.vercel-dns.com`) breaks
  nothing, and that's what `*.trollsfactory.com` needs.
- One codebase: the same `troll-pad-web` app deploys as a second Vercel
  project for trollsfactory.com in "factory mode", so every pad stays in
  sync with Troll Pad improvements automatically.
- Owner priority: **give pad owners as much control as possible**, and let
  projects on a pad allocate their fees like on Troll Pad.
- **The hook is not per-pad.** It's the shared trading engine, and nobody
  can change a live token's trading rules, including us. That's what keeps
  every pad's tokens clean for scanners. Everything else is per-pad and
  changeable by its owner.
- **"Fee allocation" on Troll Pad today is display-only.** The create
  page's creator/buyback/dividends/liquidity sliders are saved as metadata,
  and the page says they aren't enforced. The contract pays the creator's
  share in USDC. For pads it can be made real, but only before the factory
  is deployed, because the factory is one-shot.

## Why the numbers have to be right the first time

The live `TrollHook` accepts exactly **one** factory, ever
(`bootstrapFactory` is one-shot). Whatever factory we plug in is the one
every white-label pad uses forever, so we settle the money rules before
deploying it. Branding, hosting and the UI can change any time; they live
off-chain.

## What exists today, and why it can't ship as is

`TrollPadFactory.sol`, written but never deployed, charges a flat setup fee
and gives the buyer their own `TrollPortal`. Every token launched on that
pad splits its revenue **85% token creator / 15% Troll / 0% pad owner.** A
pad owner earns nothing from their own pad, so nobody would run one. The
hook only needs a pad's revenue splitter to accept `depositRevenue`, so a
new splitter that pays the pad owner too is fully compatible with the live
hook.

## Decisions (owner, 2026-09-25)

- **Split:** "Let them decide. We take 15%, then they decide how much to
  keep and how much creators on their pad get. Make it so they feel in
  control of their pad." So Troll takes a fixed **15%** of every token's
  revenue, and the pad owner sets their own share anywhere from **0 to 85%**.
  Creators get the rest. The pad owner can change it at any time; each
  token keeps the split it launched with.
- **Setup fee: $100 USDC.** We can change it later up to a $10k cap. A buyer
  passes the most they'll pay, so a fee change can't surprise them in the
  middle of a transaction.
- **Launch fee: optional, $0–$100** per launch, set by the pad owner.
  Troll's 15% applies to it too ("we take 15%" of everything a pad makes),
  so the pad owner gets 85%.
- **Network: each pad separate.** Pad tokens are not listed on
  trollpad.co's Explore page.
- **Protecting creators from surprise changes:** a creator's launch call
  includes the highest pad-owner share and launch fee they accept, so a pad
  owner can't raise either in the same moment and catch them out.

## Who's who

- **Pad owner:** someone who buys a pad, e.g. a community or influencer
  running "DogePad on Arc".
- **Token creator:** someone who launches a token on that pad.
- **Traders:** buy and sell on the token's Uniswap v4 pool, exactly as on
  trollpad.co.
- **Troll (us):** runs the factory, hosts every pad, takes the platform cut.

## Money (recommended defaults, to confirm)

"Revenue" means what a token already earns today: its buy/sell tax (0–10%,
set by the token creator) plus the 1% LP fee on the USDC side. It's split
at every flush:

| Who | Main pad (trollpad.co), unchanged | White-label pad (new) |
|---|---|---|
| Token creator | 90% | the rest of the 85% |
| Pad owner | — | **0–85%, the pad owner's choice** |
| Troll platform | 10% | **15%** |

- **Setup fee:** **$100 USDC** to create a pad, paid to the TrollTreasury.
  We can change it later within a hard cap ($10k) for promos. It only
  affects new pads.
- **Launch fee (optional):** a pad owner may charge creators $0–$100 per
  launch, paid in USDC. The default is $0. When it's above $0, creators on
  that pad need one extra approve click.
- **Locked at launch:** each token's split is written into its splitter
  when it launches and never changes. A pad owner who changes their cut
  later only affects future launches.
- **One-click payouts:** the pad owner claims their cut from every token on
  their pad in one transaction. The dashboard batches it.

## What a pad owner can set

On-chain, applying to new launches:
- their cut, 0–85% (creators get the rest of the 85%);
- launch fee, $0–$100;
- maximum tax creators may pick, 0–10% (e.g. a "no-tax pad");
- minimum starting market cap;
- payout wallet, changeable through a two-step transfer.

Off-chain (branding, editable any time, signed by the pad owner's wallet):
- name, logo, banner, theme colour, description;
- X / Telegram / website links, and an announcement bar;
- a `name.trollsfactory.com` address, plus an optional own domain;
- which tokens to feature at the top of their pad, or hide from it.

## What nobody can set

The design rule stays: no anti-snipe, no max wallet, no blacklist, no pause,
no tax change after launch, no touching the locked liquidity and no minting.
Every token on every pad is the same plain ERC-20 with the same locked
Uniswap v4 pool, so scanners see the same clean profile.

## Hosting: we host everything, the pad owner touches no code

- **One app serves every pad.** `troll-pad-web` reads the web address it
  was opened on, looks up which pad that is, and shows that pad's branding,
  tokens and create page. A new pad is live the moment its transaction
  confirms. There's no deploy, no server and no code for the pad owner.
- **Free address:** `yourname.trollsfactory.com` (see "Domain and look" above). This needs a one-time owner step: point trollsfactory.com's nameservers from GoDaddy to Vercel (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`).
- **Own domain (optional):** the pad owner types their domain and the page
  shows the one DNS record to add at their registrar (`CNAME
  cname.vercel-dns.com`, or `A 76.76.21.21` for a bare domain). We attach
  it through the Vercel API, which issues the SSL certificate. This needs a
  Vercel API token in the site's server env; the owner creates it once.
- **Data:** a `pads` table in the same Neon database, filled from
  `PadDeployed` events (the same incremental scan as launches) plus signed
  branding edits.
- **Moderation:** we can take a pad's branding and subdomain off our
  hosting, e.g. for impersonation or scams. Its on-chain pad keeps working
  through the SDK, because we can't and shouldn't touch that. Names like
  `www`, `api`, `admin`, `troll` and `trollpad` are reserved.
- **Separate pads:** each pad's tokens show only on that pad (owner decision).

## "Create your pad": the whole flow for a non-coder

1. Click "Launch your own pad" on trollsfactory.com and connect a wallet.
2. Pick a name; `name.trollsfactory.com` availability shows as you type. Upload a
   logo and pick a colour.
3. Money: a slider for your cut (0–85%) that shows the creator's share next
   to it, plus a launch fee ($0 default) and max tax.
4. Review: a live preview of the pad, and the total cost ($100 plus a few
   cents of gas).
5. Two clicks, approve USDC and create. It shows "Your pad is live at
   name.trollsfactory.com" with a share button.
6. Dashboard: earnings, a one-click claim, branding edits, domain setup,
   and featured tokens.

## Build order (after the numbers are confirmed)

1. Contracts: `PadPortal`, a 3-way `PadRevenueSplitter` with a batch
   claim, and a new factory. Include full tests, the audit-style regression
   suite and a mainnet-fork test against the live hook.
2. Owner deploys the factory and plugs it into the hook with
   `bootstrapFactory`, using their own wallet, same as the first deploy.
   Verify on Sourcify.
3. Site: multi-tenant routing, the pads table and indexer, the create-a-pad
   wizard and the pad dashboard.
4. Hosting: nameserver move, wildcard `*.trollpad.co`, the custom-domain
   flow.
5. SDK and docs: `createPad`, pad-aware `fetchLaunches`.

## Contracts (built 2026-09-25)

- `src/PadRevenueSplitter.sol`: three-way, pull-based split.
  `PLATFORM_SHARE_BPS = 1500`; `padOwnerShareBps` (≤ 8500) is fixed at
  launch; the creator gets the rest, including rounding dust.
  `claimPadOwner` pays the pad's *current* owner, read from the portal,
  and returns 0 instead of reverting so the portal can batch it. It keeps
  the same `creator` / `claim` / `claimPlatform` / `creditedTo*` /
  `isMainPad` surface as `TrollRevenueSplitter`, so the creator card works
  unchanged.
- `src/PadPortal.sol`: `TrollPortal`'s launch mechanics, copied unchanged
  (`_seedLaunchPool`), plus:
  - `PadSettings {padOwnerShareBps ≤ 8500, maxTaxBps ≤ 1000, launchFee ≤
    $100, minStartingMarketCapQuote ≥ $100}`, set by the pad owner;
  - `createLaunch(params, maxPadOwnerShareBps, maxLaunchFee)`, which
    reverts with `TermsChanged` if the pad's terms rose above what the
    creator agreed to;
  - the launch fee, split 15% treasury / 85% pad owner at launch;
  - `claimPadOwnerFees(from, to)` / `claimPlatformFees(from, to)`, one
    transaction for a whole range of launches, and
    `pendingPadOwnerFees(from, to)` for the dashboard;
  - two-step pad ownership transfer. Unclaimed earnings follow the pad.

  It emits the same `LaunchCreated` event as `TrollPortal`, so indexers,
  the SDK and the site read pad launches unchanged, plus `LaunchTerms`.
  `TrollPortal.sol` itself is untouched, so the verified mainnet portal
  still matches its source.
- `src/TrollPadFactory.sol` (rewritten; the old version was never
  deployed): `deployPad(label, settings, maxSetupFee)` takes the setup fee
  to the treasury, deploys the pad and authorizes it on the hook. The owner
  can only `setSetupFee`, which must be above 0 and at most $10k, and
  ownership transfers in two steps. Runtime size is 22.0 KB against the
  24.6 KB limit.

**Tests.** `forge test`: 36 pass, 2 fork tests skipped. The 13
`test_Pad_*` tests cover:
- the setup fee and its guard, and the owner-only fee change;
- the exact 15 / owner / rest split and all three payouts;
- the 85% cap and the $100 launch-fee cap, and the launch fee's 15/85 split;
- the creator terms guard, the pad's max tax and minimum market cap;
- settings changes only affecting future launches, and ownership transfer;
- no trading restrictions;
- a blocklisted pad owner only blocking their own payout.

Seven deliberate breaks (share, guards, caps, payout recipient) each made
a test fail. `test/ForkPadFactory.t.sol` runs on a **mainnet fork against
the live hook and treasury**: it deploys the factory, calls
`bootstrapFactory` from the owner's wallet, buys a $100 pad, pays a $20
launch fee (85/15), trades, sees exactly 5% tax, pays all three parties in
real USDC, and confirms the slot is closed afterwards. It passes.

**Deploy (owner only):**

```
cd Tr/launchpad && git pull && bash script/setup-deps.sh
forge script script/DeployPadFactory.s.sol --rpc-url https://rpc.mainnet.arc.io \
  --broadcast --account trollpad-deployer --sender 0xa6D8921021547557F4b6e3AFb0a491C67f290fF4
```

Dry run on a mainnet fork from the owner's address (nonce 4): the factory
lands at `0x547CAd7Bd7e39117856D1D72fc11465b551868d5` if this is the
wallet's next transaction. About 6.4M gas, roughly $0.13 at 20 gwei. Then
verify on Sourcify:

```
NETWORK=mainnet VERIFIER=sourcify TREASURY=0x468d90d972beDC6da7A14c2b38d80DC5c198ba5d \
HOOK=0x2F754F4cD34d415c39589BD60d245f9B484aa8cc PORTAL=0xd370c98C10a97B5e1B09770Cd5a83F0D1a59049e \
DEPLOYER=0xa6D8921021547557F4b6e3AFb0a491C67f290fF4 FACTORY=<factory> bash script/verify.sh
```

Don't deploy until the site is ready, or at least the create-a-pad page:
a factory with no front end just sits there.

## v2 (2026-09-25): real fee allocation, more pad-owner controls, Troll Pad redeployed as a house pad

Owner: "if those sliders don't work, everybody wants those sliders to work
… redeploy the pad … make sure those sliders also work on the white-label
pads … no sniping, no protection, we want all the trading we can get."

**Real fee allocation, on every pad including Troll Pad.** A creator splits
their share across up to 5 payout wallets plus a buyback & burn share,
adding up to 100%, locked at launch.
- Payouts are pull-based. Anyone can call `distribute()`, and a wallet
  can `claim()` its own share or move its own slot with `updateRecipient`.
  Nobody else can move it, and the percentages never change.
- Buyback & burn: the bucket fills in USDC. Only the creator can call
  `executeBuyback(amount, minOut)`. It swaps on the token's own pool,
  paying normal buy tax, and sends every token bought to `0x…dEaD`. The
  creator-only trigger and the min-out guard keep bots from sandwiching it.
- "Dividends" and "liquidity" from the old display-only sliders are gone.
  Holder dividends and auto-liquidity are much heavier features and aren't
  built; add a wallet for them instead.

**Pad-owner controls** (none touch trading):
- their share, up to 100% minus Troll's share;
- min and max tax;
- launch fee up to **$1,000** (was $100), split Troll/owner by the
  platform share;
- minimum and **maximum** starting market cap (the max was added later;
  Troll Pad caps it at $10k, see "Starting market cap cap");
- **pause new launches** (existing tokens keep trading);
- **invite-only** with `setApprovedCreators`;
- two-step ownership transfer and batch claims.

**House pads.** The factory owner can open pads where Troll takes **10%**
(`deployHousePad`, no setup fee). White-label pads stay at 15%.

**Why a redeploy works without a new hook.** The live hook's main-portal
slot is used by the old TrollPortal, which has 0 launches. Its factory slot
is still open, and the factory can authorize portals. So the deploy script
plugs in the factory and opens the new Troll Pad as a house pad: same hook,
same treasury, new portal address. The old portal is retired: the site
stops pointing at it, and its launch count stays 0.

**Contracts.**
- `PadRevenueSplitter` is now an EIP-1167 clone per launch (the token is
  never a clone), initialized in the launch transaction. The
  implementation is sealed.
- `PadPortal` takes `platformShareBps` and the splitter implementation.
- `TrollPadFactory` gains `deployHousePad` and `splitterImplementation`.
- Sizes: PadPortal 18.0 KB, splitter 9.4 KB, factory 22.6 KB (limit 24.6 KB).

**Tests.**
- `forge test`: 43 pass. There are 20 `test_Pad_*` tests, covering:
  - the house pad at 10% (owner-only) and white-label pads at 15%;
  - multi-wallet splits, rotating a slot, and allocation validation;
  - buyback & burn (creator-only, slippage guard, bucket bounds, burn to
    dead, normal tax paid);
  - pause, invite-only, the min/max tax range, the $1,000 fee cap, and the
    sealed splitter;
  - no trading restrictions.
- 13 deliberate breaks, each caught.
- Mainnet fork against the live hook (`ForkPadFactory.t.sol`): the house
  pad, a white-label pad with a 70/30 allocation, a real buyback & burn, and
  all payouts. Passes.

**Deploy rehearsal on a mainnet fork, broadcast as the owner's wallet**
(`--slow`; without it anvil stranded the later transactions in its
queue):

The addresses below are from the re-run with the template slot (see
"Template slot" below). Before the slot, the house pad was expected at
`0xC785…FF58`. **That address is now the template, not a pad.** Don't point
the site at it.

| Contract | Address, if these are the wallet's next transactions (nonce 4, 5) |
|---|---|
| PadRevenueSplitter implementation | `0x547CAd7Bd7e39117856D1D72fc11465b551868d5` |
| TrollPadFactory | `0x7Bec7Bc54E0E995a2d6ee0F1d9E3A4Ac42f6bcE8` |
| PadPortalTemplate (created by the factory) | `0xC7856938640D6f8Ea5F84C8B1aE86F39ffE5FF58` |
| **Troll Pad (house pad)** | **`0xd8973a0c3Ec63572b252dA745F390d3C5CCdb487`** |

Later on 2026-09-26 the owner added template #2 (holder dividends), and
trollpad.co moved to the holders Troll Pad
`0xFf5154A998b713686488D997757FC8A3f06696D6`. That pad was built by
HolderPadTemplate `0xB19C7DfF01a585A2f44d1fF2dD48Ab1346C84852` on this
same factory. The v2 pad above had 0 launches. See docs/HOLDER-DIVIDENDS.md.

The script estimates about 16.0M gas for the whole thing, roughly $0.32
at 20 gwei. After the rehearsal, `sdk/examples/fork-e2e.mjs` passed 24/24
against that new Troll Pad:
- the 60/20/20 allocation;
- claims, "Pay all wallets" and claimPlatform;
- buyback & burn of exactly the quoted tokens.

**Deploy (owner only):**

```
cd Tr/launchpad && git pull && bash script/setup-deps.sh
forge script script/DeployPadFactory.s.sol --rpc-url https://rpc.mainnet.arc.io \
  --broadcast --slow --account trollpad-deployer --sender 0xa6D8921021547557F4b6e3AFb0a491C67f290fF4
```

Then set Vercel `NEXT_PUBLIC_PORTAL` to the printed Troll Pad address and
`NEXT_PUBLIC_PORTAL_GENESIS_BLOCK` to its deploy block. Merge the site's
allocation UI to `main` together with that switch, not before: the new
create page doesn't work against the old portal.

Verify on Sourcify: the splitter implementation, factory, template and
Troll Pad. The script reads the implementation and template from the
factory:

```
NETWORK=mainnet VERIFIER=sourcify TREASURY=0x468d90d972beDC6da7A14c2b38d80DC5c198ba5d \
HOOK=0x2F754F4cD34d415c39589BD60d245f9B484aa8cc PORTAL=0xd370c98C10a97B5e1B09770Cd5a83F0D1a59049e \
DEPLOYER=0xa6D8921021547557F4b6e3AFb0a491C67f290fF4 FACTORY=<factory> HOUSE_PAD=<troll pad> \
bash script/verify.sh
```

`verify.sh` had the factory's old six-argument constructor, which would
have failed verification. It's fixed.

**Site, built and browser-tested, on the branch only (not `main`).** The
create page's "Fee Allocation" section replaces the display-only sliders:
- up to 5 payout wallets (the first defaults to the connected wallet), a
  buyback & burn slider, and a must-total-100% check;
- it reads the pad's real terms (platform and pad share, tax range, min
  market cap, launch fee, paused, invite-only) and sends them as the
  creator's max-terms guard;
- when a pad charges a launch fee, it approves it first.

The token page's "Fees & Payouts" card shows:
- the real split (Creator / Platform / Pad);
- each wallet's share and what it's owed, and the buyback bucket;
- how much has been burned so far;
- the buttons Flush tax, Harvest LP fees, "Claim my X USDC", "Pay all
  wallets" and, for the creator, "Buy back & burn". The burn uses a live
  quote with a 3% guard.

`troll-pad-web/scripts/e2e-alloc-fork.cjs` passed on the rehearsed deploy:
1. The page set 50/30 + 20% buyback, and the chain stored exactly that.
2. The card showed "Creator 90% · Platform 10%" and each wallet's share.
3. A trade-panel buy went through.
4. Flush tax credited 0.1350 / 0.0810 / 0.0540 (exactly 50/30/20 of the
   creator's $0.27).
5. Buy back & burn burned 50,444 tokens, and the card showed it.
6. Pay all wallets paid the second wallet.

No page errors. This part of the site goes to `main` together with the
`NEXT_PUBLIC_PORTAL` switch after the owner's deploy.

## Template slot (2026-09-25): room for new kinds of pads

Owner: "Drive" (answering "add the factory template slot before the
deploy?").

**Why.** TrollHook lets exactly one factory authorize portals, once. The v2
factory could only build one kind of pad: USDC-quoted, standard ERC-20
launches. After the deploy that would have been frozen forever. Ideas like
Fork Wars (coins paired against another coin) or Troll Faces (a token plus
an NFT) would have needed a brand-new hook.

**What changed.**
- `IPadTemplate` (`src/interfaces/IPadTemplate.sol`): a plug-in that builds
  a pad. `deployPortal(padOwner, platformShareBps, config)` returns the new
  pad.
- `PadPortalTemplate` is template #1. The factory creates it in its own
  constructor and builds every `deployPad` / `deployHousePad` pad through
  it. Only the factory may call it. Moving PadPortal's bytecode out of the
  factory also took the factory from 25.1 KB (over the limit) to 6.9 KB.
- New on the factory: `setTemplateApproved(template, bool)` (owner only,
  contracts only), `deployPadFromTemplate(template, label, config,
  maxSetupFee)` (the same $100 and 15% as a standard pad),
  `deployHousePadFromTemplate(template, label, padOwner, config)` (owner
  only, 10%), `templateOf(pad)`, `isApprovedTemplate(template)` and
  `padPortalTemplate()`.
- The factory checks every new pad before the hook trusts it. It must be a
  contract that isn't already a pad, on this factory's hook,
  PoolManager and treasury, charging Troll's exact share and owned by the
  buyer. Otherwise the whole transaction reverts and the buyer pays
  nothing.
- Revoking a template stops new pads from it; pads it already built keep
  working.
- Unchanged: the factory's constructor (the deploy command is the same),
  `deployPad` / `deployHousePad` and their events, and PadPortal's bytecode
  (17,994 B). A standard pad's `factory()` now reads the template's
  address; the template's `factory()` is the TrollPadFactory.

**Trust.** The factory owner key can now add new kinds of pads. It still
can't touch existing coins, pools or fees: each pool is bound to the portal
that created it.

**Tests.**
- `forge test`: 53 pass. The 10 new `test_Template_*` tests cover:
  - approval (owner only, contracts only) and unapproved templates
    rejected;
  - the built-in template serving only its factory;
  - a new kind of pad whose coins are paired against another token. It
    launches, trades, takes 3% tax in that token and pays Troll 15% in that
    token;
  - template house pads (owner only, 10%) and the setup-fee guard;
  - seven mis-wired pads rejected with the buyer charged nothing: wrong
    hook, PoolManager, treasury, share or owner, an existing pad, and no
    code;
  - revoking stops new pads only.
- Both fork tests pass against the live hook.
- Deploy rehearsed again as the owner's wallet on a mainnet fork (`--slow`):
  success, addresses in the v2 table above. On-chain checks after the
  rehearsal:
  - the hook trusts the new Troll Pad and not the template;
  - `templateOf(Troll Pad)` is the template, and the pad is a house pad;
  - owner, $100 setup fee, 10% share and 17,994 B of PadPortal code are all
    correct.
- `sdk/examples/fork-e2e.mjs` passes 24/24 against the new Troll Pad.
- Mutation run: all 17 deliberate breaks to the template code are caught,
  after adding two tests (a pad with no owner, and a template house pad from
  an unapproved template). `forge test`: 53 pass.

## Starting market cap cap (2026-09-25): Troll Pad opens at $10k at most

Owner: "don't let them start higher than 10k mc", then "yes cap it" (in the
contract, not just the site).
- `PadSettings` gains `maxStartingMarketCapQuote`, **appended last** so
  existing tuple indexes don't move. `settings()` now returns 8 values.
- A pad owner sets it anywhere from their own minimum up to the $1T
  ceiling. `createLaunch` reverts with `StartingMcOutOfRange` above it, for
  the site, the SDK and bots alike.
- The deploy script opens Troll Pad with **$100 minimum, $10k maximum**,
  and refuses to finish unless the pad really reports $10k.
- `verify.sh`'s house-pad settings tuple has the new field.
- Site (v2 branch): the create page shows only presets inside the pad's
  range (never above $10k) and validates against it. The SDK's `PadTerms`
  has `maxStartingMarketCapQuote`.

Checks:
- `forge test`: 55 pass, including two new tests: the cap is enforced, and
  a max below the min or above $1T is rejected.
- 3 deliberate breaks to the new checks are each caught.
- Both fork tests pass against the live hook.
- Deploy rehearsed again as the owner's wallet on a mainnet fork: same
  addresses as before (the Troll Pad is still `0xd897…b487`), about 16.5M
  gas, roughly $0.33.
- `fork-e2e.mjs` passes 25/25, including a new check that a $10,001 launch
  reverts on-chain.
- The browser E2E (`e2e-alloc-fork.cjs`) passes on the capped pad.

## Deployed on Arc mainnet (2026-09-26)

- Factory: `0x7Bec7Bc54E0E995a2d6ee0F1d9E3A4Ac42f6bcE8`.
- Template #1: `0xC7856938640D6f8Ea5F84C8B1aE86F39ffE5FF58`.
- Splitter implementation: `0x547CAd7Bd7e39117856D1D72fc11465b551868d5`.
- Troll Pad (house pad): `0xd8973a0c3Ec63572b252dA745F390d3C5CCdb487`,
  block 22775547.

Addresses matched the rehearsal exactly, it cost 0.2448 USDC of gas, and
everything is verified on Sourcify. White-label pads can be bought from the
factory on-chain now ($100). The trollsfactory.com create-a-pad site isn't
built yet.

