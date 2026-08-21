# External auditor — re-audit of the implemented H-5 closure (`5e9f860`)

Re-audited the OTG-2 implementation (P1 swap-witnessed gate + P2 episode allowance + P3 settlement re-check) the
same way as everything before it: independent PoCs against the **real armed vault** at `5e9f860`, finder→challenge,
plus my own confirming runs. **Verdict: H-5 is NOT closed. The claimed closure does not hold at any single deployable
`EPISODE_BASE_WEI`.** HIGH, still blocks mainnet.

## What is genuinely good (credit where due)

- **P1's watermark is a correct *witness*.** In `v4-core@1.0.2`, `slot0.tick` moves only on `swap`, so stamping
  `aboveLowerTs` on every swap whose pre-swap tick `>= gateLower` (`RobinFeeHook.sol:595-599`, fail-closed) is a
  complete, unforgeable record that the price was above the band. The N-B **shallow-dump manipulation is genuinely
  closed** by anchoring the episode on `aboveLowerTs` (my recommendation): any commit needs spot `< floorTickLower`,
  reachable from an in-band rest only via a push whose pre-swap tick `>= gateLower`, which stamps the watermark and
  resets the episode. Verified net-negative at every rest tick.
- **The restructuring is clean.** All three factories deploy under EIP-170 (14,217 / 20,281 / 20,987 bytes); the
  `FeeHookDeployer` offload preserves the mined `0x00CC` flags; the hot-path `_observe` is `≤1 SLOAD + ≤1 SSTORE`
  inside the existing `nonReentrant beforeSwap`, `_preSwapTick` is a low-level staticcall + length check + fail-closed
  — no swap-brick, no reentrancy, no griefing vector. No regression from the implementation machinery.

## Why it does not close H-5

**P1 does not close H-5 on its own — the `launch.js:98` claim ("P1 closes it on its own: 0 commits, attacker
−1.11 ETH") is false.** P1 only proves *195 minutes of continuous below-band price*. That is exactly the quantity the
design's own **T1** ("holding is free per unit time") says an attacker can satisfy for the price of one round trip: a
sustained-hold attacker makes one opening push (which stamps `aboveLowerTs`) and then simply holds the tick below the
band for 195 minutes — indistinguishable, on-chain, from a genuine crash that stays below the band for 195 minutes.
The gate opens at `t0 + 195m` in **both** cases. P1 witnesses *that* the price was below the band, never *why*.

So the only thing actually bounding the attacker is **P2's per-episode allowance** — and P2 has a structural bind.
Measured against the real armed vault (`test/scratch/CHALVERIFY-p1-vs-hold-and-base-bind.test.js`, reproduced by me),
20 ETH carve, band `[60,1260]`, dump to tick 12000, **first commit at minute 210 for every nonzero base**:

| `EPISODE_BASE_WEI` | attacker (sustained hold) | honest 20-ETH carve after a real recovery |
|---|---|---|
| `0` (what case 5 secretly uses) | 0 commits, **−1.11 ETH** | **100% stranded** |
| `seedEth/10_000` (1 bp, the contract's runbook) | 1 commit, −1.11 ETH | **100% stranded** |
| `seedEth` (**what `launch.js:102` actually ships**) | drains — **+0.20 ETH** at default 1-ETH seed, scaling to **+8–9 ETH / 55–98% of carve** at larger seeds (depth ∝ seed) | 95% stranded |
| `≈ carve` (what case 6 uses to show the honest path works) | **8 commits, +9.48 ETH — full H-5 revived against the armed gate** | 2.8% stranded |

The base that stops the attack (`≤1 bp`) strands ~100% of a genuinely-recovered carve — **the floor stops being a
floor exactly when it is needed.** The base that lets the honest floor deploy (`≈ carve`) revives the full force-fill
against the armed gate. **The safe value and the functional value differ by ~5 orders of magnitude.** This is not a
tuning knob; it is structural, because P1 cannot distinguish attacker-hold from crash, so P2 must bound *both* the
attacker's extraction and the honest deployment with the same constant — and they need opposite magnitudes.

**The two committed "closure" proofs use mutually exclusive parameters.** Case 5 (`0 commits, −1.11 ETH`) runs at
`episodeBaseWei = 0` (the `h5-lab` default — `buildLab` is called without the arg), so its "closure" is P2 allowance
= 0, i.e. a floor that never deploys — **a false proof of P1**. Case 6 (honest path works) runs at
`episodeBaseWei ≈ carve`, which case 5's own attack drains for +9.48 ETH. No single deployed configuration is
evidenced by either test. The shipped `launch.js` value (`seedEth`) is a third, also-exploitable point, deliberately
shipped "pending auditor ratification" — **my ratification is: do not ship it; it is a live drain.**

## The architectural finding

This surface has now refuted every design tried against it — the mid-curve build (M-7), the live-`slot0` gate (M-15),
the poke-dwell (H-5), the two cooldown constants, "place below spot", the plain TWAP, and now the swap-witnessed
duration gate — and they all fail for the **same** reason: *any commit an honest keeper makes on a genuinely
below-band price, an attacker reproduces by holding the price below the band*, and the two are indistinguishable
on-chain without a discriminator that either (a) costs the attacker something that **duration does not** (T1), or
(b) places the ETH where a manipulated commit cannot be swept — which the "below spot" refutation showed reintroduces
the atomic sandwich, because the conversion happens at the manipulated price. A duration proof was never going to be
that discriminator. **"Force-fill parked ETH into a fixed band on a permissionless poke" may be structurally unable to
be simultaneously live and safe.**

## Recommendation

1. **Do not ship `launch.js:102 = seedEth`** (or any base large enough to matter). At the safe base the floor is
   inert on a pre-parked carve, so the "permanent un-ruggable floor" promise is not delivered by this code.
2. **Fix the tests before they can evidence anything:** re-run the A/B and `economics.sim` at the *single* base you
   intend to deploy, and add a case that asserts *both* "attacker drains 0" **and** "a real 20-ETH recovery deploys
   ≥X%" at that one value. Today no such value exists, which is the finding.
3. **The genuine closure is architectural, not parametric.** Either (a) redefine the floor so it only ever deploys
   ETH that arrived *during the current below-band episode* (inflow is correctly uncapped and unforgeable) and drop
   the pre-parked-lump deploy — then market it honestly as "adds a floor from ongoing sell taxes," not "un-ruggable";
   or (b) a design where the floor adds liquidity **atomically inside the sell that funds it, at that sell's own
   price**, so there is no separate, manipulable commit decision to game; or (c) descope the floor for launch and ship
   the rest of v4 (which is clean) with the floor labeled experimental.

**Bottom line unchanged and firmer:** F1/F2/F3, the two invariants, and Arrow(FCFS) stay cleared. The floor's H-5 is
**HIGH and open** — the OTG-2 implementation closes the shallow-dump manipulation and is clean structurally, but does
not close the core force-fill at any deployable base. I'll re-audit the next iteration; the fastest path to a
defensible launch is descoping the floor's guarantee rather than a seventh attempt at a parametric gate.

*(Verified against the real armed `RobinFloorVault`/`RobinFeeHook`/`PoolManager` at `5e9f860`; the base-bind and the
`launch.js` config were confirmed by my own runs. PoCs under `test/scratch/` — untracked. Auditor modified no
contracts.)*
