# Getting Robin Labs listed

Being invisible costs more than any mechanism on the roadmap. This is the checklist, in the order I'd do it.

**Two facts to have to hand for every form:**
- Site `https://www.robinlab.io` (use the **www** — the bare domain 308-redirects and some forms won't follow it)
- Icon `https://www.robinlab.io/assets/logo-mark.png` (256x256 PNG)
- Repo `https://github.com/Robinlabz/Labs` · Docs `https://www.robinlab.io/docs.html`
- Chain: Robinhood Chain, chainId **4663** · Category: **Launchpad**

---

## 1. DefiLlama — the one that matters most · FREE

Everyone benchmarks off it, and the "best launchpad" roundups are largely scraped from it. Not being there is
why nobody counted you.

**It is a code PR, not a form.** I've written the adapter: `listings/defillama-robinlabs.ts`.

1. Fork `https://github.com/DefiLlama/dimension-adapters`
2. Drop the file in as `fees/robin-labs/index.ts`
3. `npm test fees robin-labs`
4. Open the PR — **tick "Allow edits by maintainers"**, it gets rejected without it
5. Merged adapters show up within ~24h

**Before submitting, two things need checking in their repo** (I could not verify them from here):
- Does `CHAIN.ROBINHOOD` exist in `helpers/chains.ts`, and is that the exact spelling? They track the chain,
  so it should — but if the constant differs, the adapter won't compile.
- Confirm `getLogs` decodes the named event fields on that version; if not, switch to positional args.

For metadata changes later (logo, links, description): **metadata@defillama.com**.

## 2. DexScreener — where traders actually look · $299

Pairs already appear automatically once a pool exists. What's missing is your *identity* on them — logo,
description, socials, website.

- **Enhanced Token Info** — $299 at `marketplace.dexscreener.com/product/token-info`. Buys the header, socials
  and description on the token page.
- Free alternative: get onto **CoinGecko's** token list and DexScreener pulls the info automatically. Slower,
  costs nothing. Do this regardless.
- Prerequisite either way: **the contract must be verified** on Blockscout, with name/symbol/decimals correct.

## 3. CoinGecko + CoinMarketCap — for $ROBIN · FREE

Both are free applications and both feed other sites, including DexScreener. Apply with identical data on each
— inconsistency between the two is the usual rejection reason.

Have ready: contract address, verified explorer link, logo, site, docs, socials, and a one-line description.

## 4. Uniswap Launch Aggregator

Carried ~340K tokens and ~$3.6B in July, and it is on the chain you launch on. I could not find a public
submission route — likely a direct approach to Uniswap Labs. Worth a message; the upside is large and the cost
is an email.

## 5. The roundups

`bitrue.com`, `bitcoinfoundation.org`, `airdropalert`, `launchpad.meme` and similar all publish "best Robinhood
Chain launchpads" lists, and most of them source from DefiLlama. **Land #1 and several of these follow on their
own.** For the rest, most take a submission or a press contact.

## 6. Robinhood Chain's own ecosystem page

If the chain publishes an ecosystem directory, being on it is free, high-signal, and usually just a form.

---

## Order, and why

1. **DefiLlama** — free, unlocks the roundups downstream, and it is real work I've already done
2. **CoinGecko / CMC** — free, feeds DexScreener for nothing
3. **Verify contracts on Blockscout** — a prerequisite for most of the above
4. **DexScreener Enhanced Info** — $299, the only one that costs money, and the most visible to traders
5. **Uniswap aggregator + roundups** — an email each

Steps 1-3 cost nothing but time, and they are the ones the "we're not on any list" problem actually turns on.
