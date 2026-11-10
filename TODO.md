# To do (needs you)

Say "I'm home" and we go through these in order. Everything else is already done or running.

## Quick (a few minutes each)
- [ ] **Accept factory ownership** from the admin wallet `0x5899a0576A94327a6316E01190f951edf7645914`: send `0x79ba5097` (acceptOwnership) to the factory `0xc7891BB84805D2919573499e0D11149C8972F06D`, amount 0, gas limit 100000. Fees already go to the Treasury, which that wallet owns; this just lets you change the setup fee and approve templates.
- [ ] **Deployer key is gone** (lost with the old working folder). The leftover HYPE/USDC/GLAD at `0xDaF4…fBD0` is stuck. For tiny keep-alive trades, fund a new small wallet I generate.
- [ ] **Play Gladius Arena** and tell me what feels off: https://elysiumpad.world/arena (after the deploy) or the artifact link. Speed, difficulty, how limbs and the shield feel, anything ugly.
- [ ] **MCP registry listing** so AI clients find the server: add one DNS TXT record to elysiumpad.world at GoDaddy (I'll give you the exact value), then run `mcp-publisher` (I'll walk you through it). `server.json` is already in the repo.
- [ ] **Kinetiq ecosystem page**: join the Kinetiq Discord and the Conduit support channel and ask to be listed. I'll draft the message.
- [ ] **Elyscan**: ask @elyscanlive to pick up the Conduit-verified sources (our contracts still show Unverified there).

## Decisions
- [ ] **Alchemy RPC key** (optional): paste the URL and I'll add it as the backup RPC. Public RPCs rate-limit.
- [ ] **Deployer wallet leftovers**: about 0.022 HYPE and $0.35 USDC. Tell me where to send them or to leave them.
- [ ] **Deployer key was shared in chat**: treat it as compromised. Decide whether to rotate the admin/treasury roles to a fresh wallet.
- [ ] **Game direction**: more characters (a retiarius with a net), better roll and bash animations, or start on the NFT / token side. 258 Meshy credits left.
- [ ] **Lookalike tokens** ("Elysian Pad", "Elys Pad", "Elysium Pad (ELYSIUMPAD)") use our names. Decide if we report them or ignore them.

## Later
- [ ] DNS: `arena.elysiumpad.world` pointing at the Vyre box, if you want the game on its own address.
- [ ] `www.elysiumpad.world` has no certificate yet (DNS record needed).
- [ ] Share the private artifact links (the game) with anyone who should play.
