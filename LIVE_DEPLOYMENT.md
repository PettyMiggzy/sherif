# Robin Labs — LIVE deployment (Robinhood Chain, chainId 4663)

**v2.1 — configurable fee stack + fast-graduation Bond-exemption fix.** Deployed from the ceiling-only
stack with the owner-governed `FeeConfig` dial (LP creator split + swap platform/creator/floor split,
retunable with a setter — no redeploy). v2.1 adds the fix so a coin graduating inside its 300s anti-snipe
window exempts the Bond it posts, keeping `Bond.poke()` and Bond trading unblocked. Cost ~$3.93.
OWNER = the cold wallet. Factory deploy block: **17752965**. Deployed: 2026-07-24.

## Live contract addresses (v2.1)
| Contract | Address | Verified on Blockscout |
|---|---|---|
| **CurvePadFactory** (launch) | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` | ✅ |
| **PadRouter** (all trades) | `0xA6BaAB820809C7fC8350311776627298f91F07eC` | ✅ |
| **FeeConfig** (fee dial) | `0x064D977B66FCC29256510dBCD8cC0C51bBb2De14` | ✅ |
| **FloorCoopFactory** | `0x564EDF561Bed46C972d5D44D84f5FAc9C5118668` | ✅ |
| **PlatformFeeSplitter** | `0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a` | ✅ |
| LaunchTokenDeployer | `0xb3748cB6ba4e47b885f8333aCa8C004A4657383d` | ✅ |
| CurvePoolDeployer | `0x020524511aD8B99828b19DA0FD3Bb7BE919A080c` | ✅ |
| BondDeployer | `0x8B04d9e55C904d6D371eA6e81ecb2a0911843AD3` | ✅ |
| RewardVault | _(not deployed — rewards program disabled)_ | n/a |
| WETH (chain infra, unchanged) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | n/a |
| Uniswap v3 Factory (chain infra) | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | n/a |

- **OWNER / platform / poster / guardian / floor-treasury:** `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf` (cold)
- **Deployer (hot):** `0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8`
- Explorer: https://robinhoodchain.blockscout.com/address/0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074

## Fee model (v2 — all owner-tunable via FeeConfig, no redeploy)
- **LP fees** (the in-protocol Uniswap 1% on every trade): split **platform 90% / creator 10%** by
  default (`lpCreatorBps = 1000`, hard cap 5000 = 50%). Read by `CurvePool.collectFees()`.
- **Swap desk fee** (the router's cut): split **platform 45% / creator 45% / floor 10%** by default
  (`swapPlatformBps/swapCreatorBps/swapFloorBps = 4500/4500/1000`, must sum to 10000). Read by
  `PadRouter._distribute`.
- **Graduation** stays ceiling-only at **4.2 ETH**; the creator still receives **0.5 ETH** at graduation.
- Retune from `admin.html` → **Fee dials** (owner-only): `setLpCreatorBps`, `setSwapSplit`.

## What's already done
- ✅ v2.1 contracts deployed + verified on Blockscout (source readable) via the V2 `standard-input`
  endpoint (the shared verifier `scripts/lib/blockscout.cjs` uses V2, so coins verify robustly too).
- ✅ On-chain wiring confirmed: `router.factory`/`router.feeConfig` and `factory.router`/`factory.feeConfig`
  all cross-linked; `FeeConfig` owned directly by the cold wallet with defaults 10/90 LP · 45/45/10 swap.
- ✅ `pad/assets/config.js` + `launchpad/deploy.json` + all docs updated & pushed (Vercel auto-deploys the
  site to www.robinlab.io / www.robinlabs.fun on push).
- ✅ Full sim suite (97 passing) + 4 parallel adversarial audits + a re-audit of the fix — all clean.

## What's left
**On the droplet (re-point the indexer to v2.1 + wipe the old board):**
```
cd ~/sherif && git pull
# set these in indexer/.env:
#   FACTORY=0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074
#   ROUTER=0xA6BaAB820809C7fC8350311776627298f91F07eC
#   START_BLOCK=17752965
docker compose -f indexer/docker-compose.api.yml down
docker volume rm indexer_indexer-data          # wipe the old-factory board (incl. the old test coin)
docker compose -f indexer/docker-compose.api.yml up -d --build
```
The old test coin lived on the *old* factory, so re-pointing to the new factory drops it automatically; the
volume wipe just clears the DB so the board starts empty. Restart the coin auto-verifier too (`--build`).

**From the cold wallet (0xCDD5…):**
1. **Accept router ownership:** `admin.html` → connect cold wallet → Ownership → Router → **Accept**.
   (The router works before this — it just moves admin keys off the hot deployer. FeeConfig + factory are
   already owned by the cold wallet directly — no accept needed there.)
2. **Launch $ROBIN:** `create.html` → name, symbol, socials → optional dev buy → Launch.
3. **Then verify $ROBIN's contracts** (token + curve; bond exists after graduation):
   ```
   cd launchpad && npx hardhat compile      # if artifacts are missing on the box
   node scripts/verify-coin.cjs <ROBIN_token> <ROBIN_curve>
   ```

## Coin auto-verifier — START THIS so coins verify hands-off
Every launched coin's token/curve (and bond at graduation) auto-verifies on Blockscout, but ONLY while
this service runs. Start it once on the droplet (it backfills, so it catches coins launched before it
started — including $ROBIN). The image compiles the contracts itself; no pre-build needed:
```
cd ~/sherif/launchpad
git pull
docker compose -f docker-compose.verifier.yml up -d --build   # first build ~2-4 min (npm ci + compile)
docker logs -f robinlabs-verifier                              # watch it verify coins as they land
```
Rebuild (`--build`) after any redeploy so its compiled bytecode matches the live contracts.

## Optional / later
- If the public GitBook/Mintlify docs sync from `main`, merge this branch to publish the doc updates.
