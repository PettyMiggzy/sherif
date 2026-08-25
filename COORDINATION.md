# Working in parallel

More than one agent session works in this repo at once. This file is how we stay
out of each other's way. Read it before your first push; append to the log at the
bottom when you finish a piece of work.

## Branches

Take your own branch. Do not push to someone else's — sessions are pinned to a
branch and a force-push or a clobbered file is invisible to the other side until
it has already cost an hour.

| Branch | Owner | Scope |
|---|---|---|
| `claude/robinhood-chain-website-8loxcm` | main session | site, docs, listings, contracts, DefiLlama adapter |
| _add yours here_ | | |

## Before you push

- **Never commit a `.env`.** `launchbot`'s `MASTER_SECRET` decrypts every user's
  custodial wallet key. If it reaches a commit, every wallet is drained — rotating
  afterwards does not undo it. `.gitignore` covers `.env`, `bot/.env`,
  `launchpad/.env` and `.venice_key`; do not add exceptions.
- **Do not claim what you have not checked.** Several problems in this repo came
  from writing a plausible statement instead of reading the code. Two examples
  worth learning from: the public repo advertised a Pad factory address that
  exists nowhere in the deployment, and a proposed privacy policy said the bots
  store no Telegram user ids while `launchbot` is fully custodial and stores a
  wallet key per user. Read the file, query the chain, then write.
- **The public repo is `https://github.com/Robinlabz/Labs`.** Never point anyone
  at `PettyMiggzy/sherif` — it mixes projects and is not the public face.

## Facts worth not re-deriving

| Thing | Value |
|---|---|
| Chain | Robinhood Chain, chainId 4663 |
| PadRouter | `0xA6BaAB820809C7fC8350311776627298f91F07eC` |
| CurvePadFactory (v1, live) | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` |
| $ROBIN | `0x6696fe29288b586017e6f264c0091dba6c5ebeaf` |
| $ROBIN launch tx | `0x12a444c5c4504d53de00bdaaa7de83d9be6e8acac6544b1867a07aa66abecf1c` (0.07 ETH opening buy) |
| Explorer | `https://robinhoodchain.blockscout.com` — rate-limits hard, back off |
| Deployment record | `launchpad/deploy.json` |
| Orientation | `START-HERE.md` |

**Closed.** `PadRouter.owner()` is `0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8`.
The router has exactly one `OwnershipTransferred` event — `0x0` to that address in
the constructor at block 17,752,952 — and the same address sent the creation
transaction, so it is deployer and owner both. Ownership has never moved and
`0xCDD5ff5d…` appears nowhere in the router's history. `deploy.json` was wrong and
has been corrected.

## Log

Newest first. One line each: what changed, and anything the other side must know.

- **main session** — THIS BRANCH IS THE REPO DEFAULT AND VERCEL DEPLOYS FROM IT.
  Every push here is live on robinlab.io within a minute; there is no staging step
  and no merge gate. Verified against the live site, not assumed. Treat a push as
  a publish.
- **main session** — buy bot section added to `pad/privacy.html` from the bot
  session's draft, and the boards paragraph narrowed to "post to our own channels"
  so it no longer implies a group-admin bot cannot receive messages. One sentence
  from the draft is deliberately NOT in: "removing the bot deletes the group's
  settings". The bot session flagged that `my_chat_member` -> `reg.remove()` is
  not wired yet, and because a push here publishes immediately, that sentence
  would be a live promise the code does not keep. Ping when it is wired and it
  goes in.
- **main session** — RESOLVED by reverting. $ROBIN was briefly in the frontend
  `UNI_TOKENS` while the live indexer's `UNISWAP_TOKENS` still rejected it, so the
  desk offered a coin the proxy refused (verified in production:
  `{"error":"token not allowlisted"}` for $ROBIN, allowlist cleared for a control
  token). Pulled back out rather than left broken — the owner is building a
  proper route for $ROBIN instead. Do not re-add it to `UNI_TOKENS` without
  `UNISWAP_TOKENS` changing in the same deploy. Separately: the control token got
  "No quotes available" from Uniswap upstream, so the desk may have no routable
  liquidity for anything right now — worth checking before blaming the allowlist
  for a future failure.

- **main session** — $ROBIN added to the swap desk allowlist. NOTE FOR WHOEVER
  DEPLOYS: the frontend list in `pad/assets/config.js` is only half of it. The
  indexer gates the same set from the `UNISWAP_TOKENS` env var
  (`indexer/src/uniproxy.js` builds `allowedSet()` from it), so if that env is not
  updated in the running deployment the buy button appears and the swap is then
  refused by the proxy. `indexer/.env.example` is updated; the live env is not
  something this session can reach. Also dropped the "and in our mobile apps"
  claim from `pad/privacy.html` — confirmed with the owner, no apps are live.

- **main session** — acted on all three items from the trending-bot session.
  `deploy.json` owner corrected. `pad/swap.html` no longer substitutes a coin in
  silence: a `?c=` the desk does not carry still falls back to the top-volume
  token, but now says which address was asked for and that this is a different
  coin. `pad/docs.html` names the desk fee as 1.25%/side where it previously said
  only "the swap-desk fee". Note on the fee: swap.html was already disclosing
  1.25% to users in three places, so the site was never wrong — the compliance
  brief was. $ROBIN sits in config as `platformToken`, not in `UNI_TOKENS`, so
  whether to add it to the desk allowlist is an owner decision, not a bug fix.

- **main session** — removed `bot/` (the Sheriff-PFP buy bot). It was not the bot
  Robin Labs runs and its behaviour did not match the product. Nothing outside the
  directory imported it. Recoverable from git history if it is ever wanted back.

- **main session** — Telegram bots documented in `pad/privacy.html`. The launch
  bot is custodial and the policy now says so, including no key export and that
  `/forget` destroys the key. `pad/index.html` and `pad/docs.html` gained the
  $ROBIN address and a token section. Unresolved: the policy's opening line still
  claims mobile apps, and `mobile/` looks like submission-in-progress rather than
  shipped — needs a yes or no before it goes live.
