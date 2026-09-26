# Holder dividends (2026-09-26)

The owner asked for holders as a fee slider ("Holders should been one").
Status: **LIVE on Arc mainnet since 2026-09-26.** The owner deployed it
from their wallet with `launchpad/script/DeployHolderPad.s.sol`, and
trollpad.co runs on the new pad.

| Contract | Address | Block |
|---|---|---|
| HolderTokenDeployer | `0x6E9E8bBdB76Eb8aD21c2bf0e3b54ddeBA35837f8` | 22827167 |
| HolderPadTemplate (template #2, approved on the factory) | `0xB19C7DfF01a585A2f44d1fF2dD48Ab1346C84852` | 22827171 |
| `setTemplateApproved` tx | | 22827175 |
| **Troll Pad with holder dividends** (house pad, Troll 10%) | **`0xFf5154A998b713686488D997757FC8A3f06696D6`** | **22827179** |

- **Gas:** 0.221 USDC for all 4 transactions (10.99M gas at 20.1 gwei;
  the fork rehearsal ran at about 7 gwei).
- **Addresses:** identical to the fork rehearsal.
- **Checked on-chain after the deploy:**
  - the hook authorizes the pad, and the template is approved;
  - it's a house pad built by template #2, taking 10%, owned by
    `0xa6D8…0fF4`;
  - settings: tax 0–10%, no fee, $100–$10k starting market cap, open;
  - both the new and the previous pad had 0 launches at the switch.
- **Sourcify:** the deployer and the template are exact matches (creation
  and runtime); the pad is a runtime match (it was created by the
  template). `script/verify.sh` takes `HOLDER_PAD=` for these.
- **Site:** Vercel `NEXT_PUBLIC_PORTAL` = the new pad and
  `NEXT_PUBLIC_PORTAL_GENESIS_BLOCK` = 22827179. The previous Troll Pad
  (`0xd897…b487`) is retired.

## What a creator gets

A **Holders** slider on the create page, next to Marketing, Team,
Community, Dev fund and Buyback & burn. That share of the creator's cut is
paid in USDC to everyone holding the coin, split by how many tokens each
wallet holds. Holders claim it on the token page any time. What they
earned stays theirs after they sell.

The platform cut is untouched: 10% on Troll Pad (15% on factory pads) comes
off the top first, exactly as today. The sliders only split the creator's
share.

## How it works (no live contract changes)

The live splitter can pay up to 5 wallets. The holders' share is one more
payout wallet: **the coin's own contract**. The coin then shares that USDC
out to holders.

- `TrollHolderToken`: the launch token for a holders launch. Fixed supply,
  no tax, no admin, no owner, no trading restrictions of any kind.
  - It uses standard "dividend per share" bookkeeping, so a payout costs
    the same gas for 10 holders or 10 million.
  - `distribute()` pulls the holders' slot from the splitter and shares
    what arrived. `claim()` does that first, then pays the caller. Anyone
    may call `distribute()`.
  - These addresses never earn, so their share goes to everyone else:
    - the Uniswap v4 PoolManager (it holds the pool's tokens);
    - the dead address (burned tokens);
    - the token itself and the launch's splitter;
    - the portal, which only holds the supply inside the launch
      transaction.
    The locker keeps a few wei of rounding dust from seeding the pool, so
    its share is dust too (under a trillionth of a cent).
  - Nothing is shared while fewer than 1M tokens (0.1% of supply) sit
    outside the pool. The USDC waits for the next call and nothing is
    lost. That floor also keeps the per-share number bounded, so the
    bookkeeping in a transfer can never overflow and block trading. The
    tests push $100B through 50 payouts and then move the whole supply.
- `HolderPadPortal`: a `PadPortal` with every rule inherited unchanged: pad
  owner controls, tax range, the $10k cap, pause, invite-only, fees and
  payouts.
  - `createLaunch` is unchanged and still makes a plain token.
  - The new `createLaunchWithHolders(p, alloc, holdersBps, maxOwnerShareBps,
    maxLaunchFee)` makes a `TrollHolderToken` and adds the token as the
    last payout wallet. The same splitter checks the whole split: at most
    5 wallets including holders, none at 0%, adding up to 100%.
  - It emits the same `LaunchCreated` event, so every indexer, the SDK and
    the site read these launches unchanged. It also emits
    `HolderShare(token, slot, bps)`.
- `HolderTokenDeployer`: makes the holder tokens (kept separate for the
  24 KB contract size limit). It always mints to its caller.
- `HolderPadTemplate`: template #2 for the live `TrollPadFactory`. The
  factory checks every pad it builds (hook, PoolManager, treasury, Troll's
  share, owner) before authorizing it on the hook.

Sizes: HolderPadPortal 20.6 KB, HolderPadTemplate 23.4 KB (limit 24 KB).

## Known properties

- **Dividend sniping.** Someone can buy just before a payout and sell just
  after. They get a pro-rata cut of whatever built up since the last
  payout, but pay the buy and sell tax plus the 1% pool fee on their whole
  size. Frequent payouts shrink the target: every holder's claim triggers
  one, and so does the site's "Share out" button. That's how every
  dividend token works, and there's no way to stop it without trading
  restrictions, which we don't do.
- **A contract that holds the coin** (another DEX's pool, a multisig) earns
  like any wallet. If it can't call `claim()`, its share just stays in the
  token.
- **The holders' slot can never move.** The splitter only lets a slot's own
  address move it, and the token has no function that does.

## Deploy (the owner)

One command from `~/Tr/launchpad`, signed with the owner's wallet (the
factory owner, `0xa6D8…0fF4`):

```
forge script script/DeployHolderPad.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast --slow --account trollpad-deployer --sender 0xa6D8921021547557F4b6e3AFb0a491C67f290fF4
```

It deploys the token deployer and the template, approves the template on
the factory, and opens the new Troll Pad from it. The new pad copies the
current Troll Pad's settings straight from the chain. It then checks
everything and prints the new pad's address.

After it: Claude switches the site (`NEXT_PUBLIC_PORTAL` and
`NEXT_PUBLIC_PORTAL_GENESIS_BLOCK` on Vercel) and verifies the new
contracts on Sourcify. **Before switching, check the current Troll Pad
still has 0 launches** (the script prints the count). If it has any, add
multi-pad listing to the site first, or those coins drop off the home
page. They keep trading either way.

## Tests (all run 2026-09-26)

- **Unit tests, 27 new** (`test/HolderPad.t.sol`, `test/HolderToken.t.sol`),
  on a local PoolManager with the real TrollHook. The whole suite: 82
  pass, and the 3 fork-only tests skip without an RPC.
  - They cover the template, both launch kinds and the allocation rules,
    including 6 slots refused and 100% to holders allowed.
  - Every pad rule applies to holder launches, including a pad's own tax
    cap below the hook's 10%.
  - Payouts go by balance and nobody is ever overpaid. Earnings stay after
    selling or moving tokens, and new buyers get nothing from earlier
    payouts.
  - Burned tokens never earn, and the wait below 0.1% works. The holders'
    slot can't be moved, and buyback & burn still works. If the splitter
    is down, holders can still claim.
  - The overflow bound is checked. A fuzz test ran 2,000 random runs of 60
    transfers, payouts and claims each. After every step it checks that
    eligible supply equals the holders' balances, and that the token holds
    enough USDC for every claim.
- **Mutation testing: 39 of 39 deliberate breaks caught.** The first run
  caught 38. The survivor was deleting the pad's own tax-too-high check,
  because the hook's identical 10% check still caught the test. A new test
  with a pad cap of 5% now catches it.
- **Live contracts on a mainnet fork** (`test/ForkHolderPad.t.sol`): the
  real factory, hook, treasury, splitter implementation, PoolManager and
  USDC.
  - The owner approves the template and opens the pad. A creator launches
    with holders 20%, and 2 wallets buy and sell on the real pool.
  - After a flush, the shares match balances, and both holders are paid in
    real USDC.
  - The team wallet, Troll's 10% to the live treasury and buyback & burn
    all work. A plain launch still works on the new pad.
  - A holders launch costs 2.86M gas; a plain launch is about 2.3M.
- **Deploy rehearsal**: the owner's exact command ran as the owner's wallet
  on an anvil fork. 4 transactions, all checks passed, about **0.03 USDC**
  in gas.
- **Browser, on that fork** (`troll-pad-web/scripts/e2e-holders-fork.cjs`):
  16 of 16 checks pass.
  - The Holders slider shows only on a holders pad.
  - 6 slots are refused with a clear message.
  - Team 30% + Holders 20% + buyback 10% gives you 40%, and exactly that
    is stored on-chain, with the token as the holders' wallet.
  - The token page shows "Holders · 20%" and the Holder dividends card.
  - Buying through the trade panel and flushing work. Claim paid exactly
    what the button showed (0.053999 USDC); the wallet got that minus the
    claim's gas, since gas is paid in USDC on Arc.
  - The plain allocation E2E passes on both the holders pad and today's
    Troll Pad. On today's pad the Holders slider stays hidden and the page
    says "coming soon".
  - Anvil caveat: the anvil USDC stand-in pays out without debiting the
    payer, so on an anvil fork a token's USDC balance never drops after a
    claim and the card keeps showing it as "waiting". The Foundry fork test
    uses a correct stand-in and checks the real accounting.

## Site and SDK

- `troll-pad-web`:
  - **Create page**: a Holders slider, shown only when the pad answers
    `holderTokenDeployer()`, so the site works before and after the
    deploy. 5 payout slots in total, holders count as one. Launches with
    holders call `createLaunchWithHolders`.
  - **Token page**: the Fees & Payouts card labels the token's slot
    "Holders". A new Holder dividends card shows what was paid out, what's
    waiting and your share, with Claim and Share out buttons.
  - **Sourcify auto-verify** tells the two token kinds apart (a holder
    token answers `holdersSlot()`) and submits the matching source. The
    source is in `lib/sourcify-inputs/TrollHolderToken.input.json`, with
    the same compiler settings as the plain token.
- `sdk`: `buildCreateLaunchWithHolders`, `buildClaimDividends`,
  `buildDistributeDividends` and `holderTokenAbi`.
