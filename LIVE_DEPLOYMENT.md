# Robin Labs — LIVE deployment (Robinhood Chain, chainId 4663)

**v2 — configurable fee stack.** Deployed from the ceiling-only stack with the owner-governed
`FeeConfig` dial (LP creator split + swap platform/creator/floor split, retunable with a setter — no
redeploy). Cost ~$3.94. OWNER = the cold wallet.
Factory deploy block: **17646568**. Deployed: 2026-07-23.

## Live contract addresses (v2)
| Contract | Address | Verified on Blockscout |
|---|---|---|
| **CurvePadFactory** (launch) | `0x59A9Fd6Fdb8B5Ed60ABF889b84d2C2fcc8a1dEDe` | ✅ |
| **PadRouter** (all trades) | `0xeA5b12Cbba5B1790A3b00C5C5884484bb2AABFaa` | ✅ |
| **FeeConfig** (fee dial) | `0x96a7c260E215853c38aC82c891827e5Dbf50efD8` | ✅ |
| **FloorCoopFactory** | `0x8f33ED14d81D7986A708af4C2DAD7DAEe9778D95` | ✅ |
| **PlatformFeeSplitter** | `0xCADAbB14339BE77a2Fc4D4151B1E453b81940653` | ✅ |
| LaunchTokenDeployer | `0xc53f32BCc25351043b95eE4B4D60964C65bB2541` | ✅ |
| CurvePoolDeployer | `0xb28B2CA4D456109E53c985968452d8B23392C777` | ✅ |
| BondDeployer | `0x0925cbB3Af5d632c18cd70524f389e3fa878161C` | ✅ |
| RewardVault | _(not deployed — rewards program disabled)_ | n/a |
| WETH (chain infra, unchanged) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | n/a |
| Uniswap v3 Factory (chain infra) | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | n/a |

- **OWNER / platform / poster / guardian / floor-treasury:** `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf` (cold)
- **Deployer (hot):** `0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8`
- Explorer: https://robinhoodchain.blockscout.com/address/0x59A9Fd6Fdb8B5Ed60ABF889b84d2C2fcc8a1dEDe

## Fee model (v2 — all owner-tunable via FeeConfig, no redeploy)
- **LP fees** (the in-protocol Uniswap 1% on every trade): split **platform 90% / creator 10%** by
  default (`lpCreatorBps = 1000`, hard cap 5000 = 50%). Read by `CurvePool.collectFees()`.
- **Swap desk fee** (the router's cut): split **platform 45% / creator 45% / floor 10%** by default
  (`swapPlatformBps/swapCreatorBps/swapFloorBps = 4500/4500/1000`, must sum to 10000). Read by
  `PadRouter._distribute`.
- **Graduation** stays ceiling-only at **4.2 ETH**; the creator still receives **0.5 ETH** at graduation.
- Retune from `admin.html` → **Fee dials** (owner-only): `setLpCreatorBps`, `setSwapSplit`.

## What's already done
- ✅ v2 contracts deployed + **all 8 verified** on Blockscout (source readable) via the V2
  `standard-input` endpoint (the shared verifier `scripts/lib/blockscout.cjs` uses V2, so coins verify robustly too).
- ✅ Website (www.robinlab.io / www.robinlabs.fun) serving the v2 addresses (Vercel auto-deployed).
- ✅ Indexer (droplet) repointed to the v2 factory (`FACTORY`/`ROUTER`/`START_BLOCK=17646568` set in `indexer/.env`) and the volume wiped. Board = clean.
- ✅ `pad/assets/config.js` + `launchpad/deploy.json` committed & pushed.
- ✅ Full sim suite + parallel adversarial audit across every contract (see audit run) — clean.

## What's left (YOU, from the cold wallet 0xCDD5…)
1. **Accept router ownership:** `admin.html` → connect cold wallet → Ownership → Router → **Accept**.
   (The router works before this — it just moves admin keys off the hot deployer.)
2. **Accept FeeConfig ownership** (Ownable2Step) the same way, so you can retune fees from the cold wallet.
3. **Launch $ROBIN:** `create.html` → name, symbol, socials → optional dev buy → Launch.
4. **Then verify $ROBIN's contracts** (token + curve; bond exists after graduation):
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
