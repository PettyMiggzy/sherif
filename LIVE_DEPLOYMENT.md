# Robin Labs — LIVE deployment (Robinhood Chain, chainId 4663)

Deployed from the ceiling-only stack. Cost ~0.0019 ETH (~$3.64). OWNER = the cold wallet.
Factory deploy block: **17333890**.

## Live contract addresses
| Contract | Address | Verified on Blockscout |
|---|---|---|
| **CurvePadFactory** (launch) | `0xF54032C714e186bC6e5D84230c3B25cAC2e238Ed` | ✅ |
| **PadRouter** (all trades) | `0xCA10a8821aF3D54eA9050A279EDd073654f5Fa1C` | ✅ |
| **RewardVault** | `0x5Ca5C1D2D10Bf605F9C42c5Baa0a3f897a3E3811` | ✅ |
| **FloorCoopFactory** | `0x2615120ECbe93D5DC5e9268337f42817a3224102` | ✅ |
| **PlatformFeeSplitter** | `0xF56A82476114BDadC425b850d53FEFCb847e7C65` | ✅ |
| LaunchTokenDeployer | `0x55676403eFB000b8667D0F9C6cEdbBF17b9BdcD3` | ✅ |
| CurvePoolDeployer | `0x548Fe951F2022c23bF2e896971aFCD83a39852BB` | ✅ |
| BondDeployer | `0xEe00259A69ab91b9702021571048d1eECbC80eAC` | ✅ |
| WETH (chain infra, unchanged) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | n/a |
| Uniswap v3 Factory (chain infra) | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | n/a |

- **OWNER / platform / poster / guardian / floor-treasury:** `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf` (cold)
- **Deployer (hot):** `0x2aA74C8d97d89a7Cac1243262479687e5Db30eF8`
- Explorer: https://robinhoodchain.blockscout.com/address/0xF54032C714e186bC6e5D84230c3B25cAC2e238Ed

## What's already done
- ✅ Contracts deployed + **all 8 verified** on Blockscout (source readable). The floor factory +
  splitter needed Blockscout's V2 `standard-input` endpoint — the Etherscan-compat one fails on them;
  the shared verifier (scripts/lib/blockscout.cjs) now uses V2, so coins verify robustly too.
- ✅ Website (www.robinlab.io) serving the new addresses (Vercel auto-deployed).
- ✅ Indexer (droplet) repointed to the new factory (`FACTORY`/`ROUTER`/`START_BLOCK=17333890`/`REWARD_VAULT` set in `indexer/.env`) and the old TEST/SMOKE coins wiped (`docker volume rm indexer_indexer-data`). Board = clean.
- ✅ Docs / GitBook / Mintlify / SDK / API updated for the new addresses + ceiling-only graduation.
- ✅ `pad/assets/config.js` + `launchpad/deploy.json` committed & pushed.

## What's left (YOU, from the cold wallet 0xCDD5…)
1. **Accept router ownership:** `admin.html` → connect cold wallet → Ownership → Router → **Accept**.
   (The router works before this — it just moves admin keys off the hot deployer.)
2. **Launch $ROBIN:** `create.html` → name, symbol, socials → optional dev buy → Launch.
3. **Then verify $ROBIN's contracts** (token + curve; bond exists after graduation):
   ```
   cd launchpad && npx hardhat compile      # if artifacts are missing on the box
   node scripts/verify-coin.cjs <ROBIN_token> <ROBIN_curve>
   ```

## Verification note (resolved)
All 8 verified. `FloorCoopFactory` + `PlatformFeeSplitter` initially failed the Etherscan-compat
`verifysourcecode` path ("Unable to verify") but verified cleanly via Blockscout's V2
`/api/v2/smart-contracts/{addr}/verification/via/standard-input` endpoint. The shared verifier now
uses V2 for everything, so launched coins (LaunchToken/CurvePool/Bond) verify by the same robust path.

## Coin auto-verifier — START THIS so coins verify hands-off
Every launched coin's token/curve (and bond at graduation) auto-verifies on Blockscout, but ONLY while
this service runs. Start it once on the droplet (it backfills, so it catches coins launched before it
started — including $ROBIN). The image now compiles the contracts itself; no pre-build needed:
```
cd ~/sherif/launchpad
git pull
docker compose -f docker-compose.verifier.yml up -d --build   # first build ~2-4 min (npm ci + compile)
docker logs -f robinlabs-verifier                              # watch it verify coins as they land
```
Rebuild (`--build`) after any redeploy so its compiled bytecode matches the live contracts.

## Optional / later
- If the public GitBook/Mintlify docs sync from `main`, merge this branch to publish the doc updates.
