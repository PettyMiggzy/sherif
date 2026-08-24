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
