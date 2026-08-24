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

Open question nobody has closed: `deploy.json` records the owner as
`0xCDD5ff5d…`, but a live read earlier in this work returned
`0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8` for `PadRouter.owner()`. That
address controls fee config and platform escrow. Confirm it before deploying
anything new, and correct whichever source is wrong.

## Log

Newest first. One line each: what changed, and anything the other side must know.

- **main session** — Telegram bots documented in `pad/privacy.html`. The launch
  bot is custodial and the policy now says so, including no key export and that
  `/forget` destroys the key. `pad/index.html` and `pad/docs.html` gained the
  $ROBIN address and a token section. Unresolved: the policy's opening line still
  claims mobile apps, and `mobile/` looks like submission-in-progress rather than
  shipped — needs a yes or no before it goes live.
