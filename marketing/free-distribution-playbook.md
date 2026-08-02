# Robin Labs — free distribution playbook

Generated from a research sweep. NOTE: one finding was stale — GeckoTerminal DOES already list the "robinhood" network (verified live), so the "submit GeckoTerminal listing" quick win is already done. Everything else stands.

Context correction: Robinhood Chain is a hyperactive memecoin market (~$115M/24h across the top 20 pools, ~19k new tokens/day, PONS Family = ~80% of launches). This playbook is about getting Robin's launches SURFACED into the feeds already driving that volume.


## Quick wins (do this week)

### Submit the free GeckoTerminal EVM chain/DEX listing application for Robinhood Chain + RobinSwap
- **Why:** CONFIRMED GAP: I verified via api.geckoterminal.com that 'robinhood' is NOT in GeckoTerminal's networks list (it IS live on DexScreener). This one free form is the highest-ROI action in the whole playbook — it unlocks GeckoTerminal, CoinGecko on-chain 'new pools', and every terminal built on them (BullX, Photon) that is currently 100% blind to your chain.
- **How:** about.geckoterminal.com/dex-chain-listing (linked from CoinGecko support 'How do I list an EVM chain/DEX'). Provide chain RPC, Blockscout explorer URL, RobinSwap factory address + Uniswap-fork type, wrapped-native + stable token addresses. Free, ~5-10 business day review. It's the standard Arbitrum-Orbit EVM path, so you qualify cleanly.

### Ship the launch + graduation X/Telegram auto-poster on the existing indexer
- **Why:** This is the owned flywheel and it's fully in your control, fully organic, zero third-party dependency. The indexer, Telegram bot, and per-coin share cards already exist — this is wiring, not new infra.
- **How:** twitter-api-v2 + node-cron next to the indexer, subscribed to Launched/Graduated/curve-milestone webhooks. Post each launch and graduation (lead with the permanent-floor + real Uniswap v3 LP angle), always embedding $TICKER, contract, and the dexscreener.com/robinhood/{pair} link so cashtag scrapers and relays echo it. Free X tier ~500 posts/mo; batch low-signal events into digests to stay free. Mirror every post into a public 'Robin Labs Launches' Telegram channel with forwarding on.

### List Robin Labs on the Blockscout Dappscout marketplace and push token logos/socials for every launched coin
- **Why:** The official chain explorer is where every trader inspecting a Robinhood-chain contract lands; low effort, immediately actionable, and you already auto-verify contracts.
- **How:** Submit the app via the Blockscout Airtable form (airtable.com/appiy5yijZpMMSKjT/... or the 'Submit app' button on robinhoodchain.blockscout.com/apps). Extend your existing auto-verify step to also push token metadata (square logo PNG, website, X, Telegram) to each coin's token page so it renders branded, not as a bare address.

### Auto-fill the FREE CoinGecko/GeckoTerminal 'Update Token Info' form at every launch
- **Why:** One free submission per coin propagates a verified logo + socials across GeckoTerminal, DexScreener and CoinGecko, and drops the coin into DexScreener's token-profiles feed that the downstream bot swarm polls. CoinGecko states info updates are free — anyone charging for it is a scam.
- **How:** geckoterminal.com/update-token-info (and CoinGecko 'Update Coin/Token Info', Community Takeover option for community coins). Requires the contract shown on robinlab.io + a verified social — your coin profiles already satisfy this, so automate the submission in the launch flow.

### Open the DeFiLlama Launchpad adapter PR and add Robinhood Chain as a chain
- **Why:** DeFiLlama's chain-filtered Launchpad leaderboard is literally where 'who launches the most on Robinhood Chain' gets settled publicly, and @DefiLlama (1M+ followers) auto-screenshots its top-N cards. If you genuinely lead, it becomes permanent free proof.
- **How:** Fork DefiLlama/DefiLlama-Adapters, add projects/robinlabs (TVL = curve reserves + graduated Uniswap v3 liquidity), and add 'Robinhood' to projects/helper/chains.json in the same PR ('Allow edits by maintainers' ON). Add a dimension-adapters fees/robinlabs for the Fees/Revenue board. Email metadata@defillama.com for the Launchpad category tag. Free; live ~24h after merge.

### Claim the cheap directory + builder surfaces in one afternoon
- **Why:** Low-effort free listings that produce SEO, ecosystem-page presence, and organic ranking on real wallet activity — surfaces most memecoin launchpads never bother to claim.
- **How:** Add GitHub topics 'robinhood-chain','launchpad','arbitrum-orbit','memecoin' to github.com/Robinlabz/Labs (the canonical public repo per project rules — never point to PettyMiggzy/sherif). Submit Robin Labs to DappRadar (Submit a Project) and to Arbitrum Portal (portal.arbitrum.io 'Add your project', category DeFi/Launchpad, note Robinhood Chain/Orbit). Claim CryptoRank + RootData profiles.

### Verify buy-bot chain support and wire a buy bot into every coin's Telegram (self-run fallback)
- **Why:** Green buy walls are in-community social proof that gets screenshotted to X for free and feeds the volume/txn signals that drive organic trending — and it only fires on real buys, so it's honest by design.
- **How:** Confirm Maestro / Rick / DextBuyBot support chainId 4663's RPC. Where supported, add one to each launch's Telegram pointed at the pool. Where not, run your own buy bot on your Alchemy RPC (slots into the existing launchbot) so coverage is guaranteed regardless of third-party chain support.


## Build this (owned flywheel)

### Launch + Graduation Auto-Poster (X @robinlabzz + Telegram broadcast channel)
- **What:** A cron/webhook worker beside the indexer that renders every Launched, Graduated, and 25/50/75/100% curve-milestone event into a templated post with the per-coin share card, $TICKER, contract, and dexscreener.com/robinhood link, fanned out to X and a forward-friendly Telegram channel. Add auto-firing records/milestone posts (100th/1000th coin, cumulative floor, fastest graduation) computed by the indexer.
- **Effort:** Low — indexer, Telegram bot, and share cards already exist; this is templating + twitter-api-v2 + node-cron. Batch low-signal events to stay on the free X tier.
- **Payoff:** The core flywheel. Turns every launch into free owned content that compounds followers and seeds CAs/cashtags into X's graph, where relays (TweetStream/X-Relay) and quote-bots echo them for free. This is pump.fun's 'every launch is content' mechanic on infra you already run.

### Daily 'State of Robinhood Chain' leaderboard card
- **What:** A daily cron that aggregates the last 24h across ALL Robin coins (number launched, top movers, biggest graduations, new ATHs, cumulative floor added), renders a single branded PNG (headless Chromium or satori) engineered for screenshotting — big numbers, Robin branding, robinlab.io URL — and posts + pins it to X and Telegram.
- **Effort:** Medium — reuses indexer queries; the work is the render template and cron. Optionally enrich with api.llama.fi so the card carries DeFiLlama-attributed numbers for third-party credibility.
- **Payoff:** Directly delivers the 'we top it because we really launch the most' brief. Ranked leaderboard cards are among the most-reshared crypto content; owning the canonical Robinhood-chain recap makes you the default source everyone screenshots instead of building their own.

### Public read-only launch API + websocket (let external bots build ON you)
- **What:** Expose the existing indexer as a documented free public endpoint: REST for leaderboards/per-coin stats + a websocket streaming new-launch and graduation events. Publish a single canonical factory address and a rich standardized Launched event ABI so any bot dev can whitelist 'Robin Labs' in one line.
- **Effort:** Medium — mostly a thin public read layer + docs on robinlab.io/api and in github.com/Robinlabz/Labs. The factory-address + event-ABI consistency is near-zero incremental work.
- **Payoff:** Highest-leverage multiplier here: this is the pump.fun/PumpPortal move. Every sniper, alert, and trending bot that wires in becomes a permanent distribution channel you neither operate nor pay for. Turns your data into other people's products.


## Ranked channels (best first)

1. **[dexscreener] DexScreener automatic on-chain indexing (dexscreener.com/robinhood)** — Nothing to submit — VERIFIED live (9 robinhood tokens in the token-profiles API today). Just ensure each graduation creates its Uniswap v3 pool with a real first swap and keep RobinSwap's factory events on a standard Uniswap-fork ABI so the indexer keeps parsing pairs.
2. **[aggregator] GeckoTerminal / CoinGecko on-chain chain+DEX listing application** — Submit the free EVM listing at about.geckoterminal.com/dex-chain-listing with RPC, Blockscout URL, RobinSwap factory + fork type, wrapped-native/stable addresses. ~5-10 day review.
3. **[self_run] Robin Labs self-run launch/graduation X + Telegram auto-poster** — Build on the existing indexer: auto-post every launch/graduation/milestone with share card, $TICKER, contract, DexScreener link; mirror to a public Telegram channel.
4. **[aggregator] Public read-only launch API + websocket (PumpPortal-style)** — Publish REST + websocket docs on robinlab.io/api and github.com/Robinlabz/Labs; document one canonical factory address + Launched ABI; invite bot devs to consume.
5. **[leaderboard] Daily 'State of Robinhood Chain' leaderboard card (X + Telegram)** — Cron that ranks last-24h coins from the indexer, renders a branded screenshot-optimized PNG, posts + pins daily.
6. **[leaderboard] DeFiLlama Launchpad category + protocol/chain listing (adapter PR)** — PR a TVL adapter (projects/robinlabs) + add Robinhood to helper/chains.json; add a fees/revenue dimension-adapter; email metadata@defillama.com for the Launchpad tag.
7. **[aggregator] Free metadata: CoinGecko + GeckoTerminal 'Update Token Info' forms** — geckoterminal.com/update-token-info + CoinGecko Update Coin/Token Info (Community Takeover for community coins); needs contract on robinlab.io + a verified social. Automate at launch.
8. **[explorer] Blockscout explorer token metadata + Dappscout Apps marketplace** — Submit Robin Labs via the Blockscout Airtable app form; extend auto-verify to push logo/socials to every coin's token page.
9. **[dexscreener] DexScreener token-profiles feed + free public API/WebSocket** — Populate socials so each coin enters /token-profiles/latest/v1; pursue DexScreener launchpad recognition so every Robin coin carries a 'Robin Labs' label. Build your own poster on the same free API too.
10. **[dexscreener] DexScreener New Pairs page + per-chain New-Pairs Telegram channels** — Automatic — the moment a graduation pool gets its first swap it appears on dexscreener.com/robinhood/new-pairs and any chain-scoped new-pairs TG feed. Keep contracts verified so cards render clean.
11. **[telegram] Own public Telegram broadcast channel + forward-friendly posts** — Stand up a 'Robin Labs Launches' channel; auto-post launches/graduations with inline chart/buy/contract buttons; enable forwarding; drop the daily card there.
12. **[explorer] Consistent factory address + rich Launched event ABI (detection beacon)** — Keep ONE canonical factory across all launches, emit a standardized Launched event (name/symbol/creator/socials URI), document the address + ABI in github.com/Robinlabz/Labs.
13. **[telegram] Community buy bots (Maestro / Rick / DextBuyBot) + self-run fallback** — Add to each coin's Telegram pointed at the pool; where chainId 4663 isn't supported, run your own buy bot on your RPC.
14. **[leaderboard] On-site King-of-the-Hill live board on robinlab.io** — Give the top coin (by curve progress/volume) a hero slot on the front page via the indexer websocket; make dethroning it a public goal.
15. **[aggregator] DappRadar dapp submission (Rankings / Narrative / Chain pages)** — Free 'Submit a Project' with description, visuals, contract addresses; request the Robinhood Chain page if new. Ranks on real UAW/volume.
16. **[aggregator] Arbitrum Portal ecosystem directory + @arbitrum Ecosystem Spotlight** — Submit via portal.arbitrum.io 'Add your project' (DeFi/Launchpad, note Robinhood/Orbit). Then tag @arbitrum/@ArbitrumDevs on milestones with real metrics to earn a discretionary spotlight.
17. **[other] GitHub topic 'robinhood-chain' on github.com/Robinlabz/Labs** — Add topics robinhood-chain, launchpad, arbitrum-orbit, memecoin + a README with robinlab.io / @robinlabzz / t.me/RobinLabs links.
18. **[aggregator] CoinGecko + CoinMarketCap coin listing + Launchpad category** — List graduated coins once on a tracked DEX; submit the free listing/update requests, request the 'Launchpad' category (250+ char justification) and Robinhood Chain as a supported network. CMC DexScan auto-creates unverified pages meanwhile.
19. **[other] Robinhood Chain official ecosystem directory (robinhood.com/chain/ecosystem)** — No self-serve form — route via BD/partnership through docs.robinhood.com/chain. Pitch Robin Labs as the chain's fair-launch launchpad; propose a 'Launchpad' category with Robin Labs as anchor. Lead with real metrics.
20. **[leaderboard] growthepie (gtp-dna) + L2Beat chain listings** — PR Robinhood Chain metadata to github.com/growthepie/gtp-dna (logo, RPC, DA, contracts); submit an L2Beat chain-config PR (proof system, DA, TVS).
21. **[leaderboard] Dune 'Launchpad Wars' dashboards (own dashboard + Spellbook spell)** — First confirm/request Dune indexes Robinhood Chain (gating step). Then build your own 'Robinhood Chain Launchpads' dashboard and contribute a Spellbook spell labeling your factory so other analysts' comparisons include you.
22. **[aggregator] DEXTools New Pairs / Hot Pairs + DEXTscore + DextBuyBot** — Gated on DEXTools integrating Robinhood Chain (verify current support — not confirmed). Once integrated, raise DEXTscore free via LP lock/burn, contract verification, healthy holder distribution; update logo/socials via the free form.
23. **[x_bot] Downstream X reposter bots (@DefiLlama, @DEXToolsApp, @GeckoTerminal, gainers/profiles reposters) + TweetStream/X-Relay echo** — No submit button — earned by ranking in the public feeds (real volume, completed profiles) and by consistently tweeting each CA + $CASHTAG from your own poster so relays detect and rebroadcast.
24. **[leaderboard] Token Terminal / Artemis + The Block / Blockworks launchpad dashboards** — Submit coverage/data-partner requests with fee/revenue methodology; pitch research teams a 'new-chain launchpad leader' story with ready-made Dune/Flipside queries.

## Avoid (waste or reputationally toxic)

- DexScreener Boosts / Golden Ticker — paid multiplier on an existing score, not organic rank. Traders increasingly read heavily-boosted tokens as 'traps' (DexScreener also excludes security-flagged tokens), so it can hurt trust. At most a rare one-off on a flagship graduation, never routine.
- Wash-trading / volume bots to force DexScreener, GeckoTerminal or DEXTools trending or Hot Pairs — fakes the exact volume/txn/maker signals the algorithms and the community read as organic. Violates terms, risks security flags, burns ETH, and brands the coin as manipulated. This is the direct opposite of the 'we top it because we really launch the most' mandate.
- Third-party 'trending/volume' promo vendors (PandaBoost, W3 Lab, Smithii, BoostLegends, generic DexScreener/DEXTools 'trending' sellers) — ~$1,000+/slot to spoof metrics. No privileged access, just wash trades and view/reaction bots. Superficially high reach, hollow and reputationally toxic.
- Reaction/rocket sellers and maker/holder-inflation bots — same wash-metric category at smaller scale; fakes DexScreener's Community Engagement and Market Activity buckets.
- Paying anyone who 'promises placement' on aggregators, category tags, or reposter bots — CoinGecko states info updates are FREE and legit reposter bots only mirror public rankings. Anyone charging for a metadata update or a guaranteed listing is a scam.
- Over-buying DexScreener Enhanced Token Info (~$299/coin) for the long tail — the same logo/socials propagate FREE via the CoinGecko/GeckoTerminal path that DexScreener mirrors. Reserve the paid version for flagship/graduated coins where instant verification is worth it; don't pay it per-launch at scale.

## 30-day plan

Week 1 — unlock the ecosystem and turn on the flywheel. File the free GeckoTerminal EVM chain/DEX listing (I verified Robinhood Chain is genuinely missing from GeckoTerminal while already live on DexScreener — this one form is the highest-ROI move, and it back-unlocks CoinGecko on-chain, BullX and Photon). In parallel, ship the launch/graduation X + Telegram auto-poster on the existing indexer and stand up the public 'Robin Labs Launches' Telegram channel. Same week, knock out the zero-cost listings: Blockscout Dappscout app submission + token logos, DappRadar, Arbitrum Portal, GitHub topics on Robinlabz/Labs, and auto-fill the free CoinGecko/GeckoTerminal token-info form in the launch flow. Verify buy-bot chain support and add Maestro/Rick (or a self-run buy bot) to each coin's Telegram.

Week 2 — plant the leaderboard proof. Open the DeFiLlama adapter PR (TVL + fees) and add Robinhood Chain to chains.json; this is the canonical 'top launchpad' ranking that @DefiLlama auto-screenshots. Launch the daily 'State of Robinhood Chain' leaderboard card on X + Telegram, and lock in a single canonical factory address with a documented Launched ABI in the public repo so external bots can whitelist you. Confirm whether Dune and DEXTools index the chain and, if not, request it.

Week 3 — build the multiplier. Publish the public read-only launch API + websocket (the PumpPortal move) at robinlab.io/api and invite sniper/alert-bot devs — every integration becomes a channel you never operate. Add the on-site King-of-the-Hill board so creators promote your front page for you. Submit growthepie (gtp-dna) and L2Beat chain configs for chain-level credibility, and build your own Dune 'Robinhood Chain Launchpads' dashboard as quotable raw material.

Week 4 — climb and compound. Pursue BD for the official Robinhood Chain ecosystem directory (propose a Launchpad category with Robin Labs as anchor) and submit CoinGecko/CMC coin listings + Launchpad-category requests for flagship graduates. Turn on records/milestone auto-threads. By now DexScreener + GeckoTerminal + DeFiLlama + your own poster form a loop: real launch volume climbs the organic trending and leaderboard surfaces, those get re-screenshotted by third-party bots and @DefiLlama/@GeckoTerminal, and your own cards seed the engagement that feeds the next cycle. Throughout, stay strictly organic — no Boosts, no wash volume, no paid 'trending' vendors; the entire edge is that you genuinely launch the most on a near-empty chain, so the honest metrics win the boards for you."