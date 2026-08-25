# Adversarial audit — presale platform fee + mined coin addresses

Run over commits `efe350e` (10% presale fee) and `4557167` (caller-chosen `tokenSalt`).
67 agents: five independent finder lenses, every finding put to two independent skeptics before it
counted, plus three independent designs for presale to v3. 22 findings survived refutation.

Fixed in `78c174c`: the critical salt-theft hole, the broken `LaunchParams` ABI, the missing salt
coverage, the false trust invariant in three documents, and the misplaced NatSpec.

ALL TEN CLOSED as of `e1c34cd`. One correction to the memo's own advice: finding 2 proposed doing the repair
"inside the pool constructor". That is not possible — a contract has no code at its own address until its
constructor returns, so `pool.swap`'s callback would land on an empty address. The repair runs in `seed()`
instead, which the factory calls later in the same launch transaction, so the launch is still atomic.

---

# DECISION MEMO — pre-deploy audit + presale→v3 design

Verified against HEAD `efe350e`, working tree clean (three untracked `launchpad/test/tmp-refute*/` scratch dirs from the audit agents — delete or promote them).

---

## PART 1 — AUDIT

Two independent clusters. Commit `4557167` (caller-chosen `tokenSalt`) is the dangerous one. Commit `efe350e` (10% presale fee) is documentation drift only.

### Loses user money

**1. CRITICAL — `tokenSalt` lets an attacker steal a creator's mined address, name and symbol, and become its dev.**
`launchpad/contracts/CurvePadFactory.sol:272-277`

The justification comment at `:262-268` is a category error. `LaunchTokenDeployer.deploy` folds `msg.sender` into the CREATE2 salt (`launchpad/contracts/deployers/CurveDeployers.sol:92`), but on the launch path `msg.sender` **is the factory** — one constant address for every creator. The fold defeats only direct calls to the public stateless deployer. It gives zero separation between two people who both go through `launch()`. The old salt at `:275` folded in `p.dev`; the new branch at `:272-273` folds in nothing.

Full CREATE2 preimage is now `(LaunchTokenDeployer, keccak(factory, tokenSalt), keccak(LaunchToken initcode ++ abi.encode(name, symbol, supply, factory, all-zero GuardConfig)))`. Every component is public or caller-supplied. `p.dev` and `p.tax` are in neither the salt nor the init code — free for the attacker to swap.

Concrete failure, reproduced end-to-end on a fork against real Uniswap v3: creator mines salt S for `$FOO`/`FOO` ending `1ab5`, calls `launch()`, the tx reverts (`MarketCapOutOfRange` at `:226` after an owner `setFdvBand`, `BadValue` at `:223`, or a `_devBuy` refund failure at `:331`). The reverted tx is still mined; its calldata carries name, symbol, supply and `tokenSalt` in the clear forever. Attacker copies those four values into their own `launch()` with `p.dev = attacker`, `p.tax.projectWallet = attacker`, `buyBps = sellBps = 400`. Lands on exactly the victim's address: `0xB9D6…1ab5`, `name() == "$FOO"`, `recordOf(token).dev == attacker`. Buyers who paste the announced CA buy the attacker's coin and pay him 4%/4% of every trade. The victim's retry reverts bare inside CREATE2 forever.

FCFS/no-public-mempool does **not** cover this — the attacker acts blocks later, off a reverted tx's calldata, not in a race. Your own repo already says so: `pad-v4/contracts/presale/PresaleVault.sol:35-38`.

Not live — the deployed factory `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` predates the commit. It ships with `scripts/deploy-v2.js`.

**Fix:** bind the creator at the factory layer — `bytes32 salt = keccak256(abi.encodePacked(msg.sender, p.tokenSalt))` — and mine client-side against that. Mineability is preserved; the address becomes unreproducible by anyone else. Delete the comment at `:262-271`; it asserts a defence that does not exist.

---

**2. HIGH — the same change reopens `AUDIT.md` F-1 and makes the pool brick permanent instead of retryable.**
`launchpad/contracts/CurvePadFactory.sol:272` → `launchpad/contracts/CurvePool.sol:153-158`

`AUDIT.md:73` closed F-1 on exactly the entropy this commit removes ("a retry lands a fresh address, so the DoS can't be made permanent"). That entropy is gone.

Squatting the pool needs only the **address**, never the salt and never the token. `IUniswapV3Factory.createPool(token, WETH, 10000)` has no code check on its token args — reproduced against real `@uniswap/v3-core` bytecode: `createPool` and `initialize(123456789012345678901)` both succeed on an address with `getCode == "0x"`. `CurvePool`'s constructor then reverts `BadPoolInit()` at `:157` on any pre-init price that is not `wantSqrt`. `POOL_FEE` is `constant 10000` — there is no alternate tier to escape to, and no admin recovery path.

With a mined salt every retry lands on the same address, so the brick is permanent. Verified: after the squat, `launch(p)`, `launch{value}(p)`, `launchWithSupply(p, SUPPLY, 201400)` and a different `dev` all revert `BadPoolInit`. Only a fresh salt gets past it.

Publishing a mined CA ("the real contract will be 0x…1ab5") is the entire point of mining one, so the disclosure precondition is the intended use case. No funds at risk — the constructor revert unwinds the whole tx and dev-buy `msg.value` returns. The loss is the announced address, the marketing keyed to it, and gas.

**Fix (better than re-mining):** the token is deployed at `CurvePadFactory.sol:277` before `CurvePool` at `:280`, so inside the pool constructor the token has code. On a squatted pool, do a zero-liquidity swap with `sqrtPriceLimitX96 = wantSqrt` to drag it back to the start price instead of reverting. That closes F-1 permanently for standalone launches *and* presales.

---

### Does not lose money, but blocks the deploy

**3. HIGH — `LaunchParams` gained a field and not one off-chain consumer was updated. The unit suite is red right now.**
`launchpad/contracts/CurvePadFactory.sol:87`

Selector moved: old `launch(...)` = `0xfa3885e8`, new = `0x7b231b9b`. I ran it: `npx hardhat test test/fdv-supply.test.js` → **2 passing, 6 failing**, every failure `Error: missing value for component tokenSalt` at ethers `resolveArgs`. Not fork-gated — plain `npm test` is broken today. Root cause is the `params()` helper at `launchpad/test/fdv-supply.test.js:48`; ~16 more call sites across `dress-rehearsal`, `fn-gas-cap`, `sim-*`, `trace-*` and all of `test/fork/` have the same shape (the fork ones currently *skip*, which hides it).

Every shipped client still declares the 4-field tuple: `sdk/robinlabs.mjs:69`, `launchbot/config.js:28`, `pad/assets/config.js:136` (+ `pad/assets/wallet.js:640`), `pad/docs.html:402` — the ABI published to third-party integrators. `CurvePadFactory` has `receive()` but no `fallback()`, so the instant the new factory is deployed every Telegram-bot launch, every `pad/create.html` launch and every SDK launch reverts.

The feature is also unreachable: `grep tokenSalt` over `.js/.mjs/.html` in `launchpad/`, `pad/`, `sdk/`, `launchbot/` returns nothing. `FEATURES.md:19` still lists A5 as "NOT BUILT ANYWHERE." The commit message's "defaulting to 1ab5 in the UI" describes a UI that does not exist.

**4. MEDIUM — zero test coverage on the branch that changed behaviour.** `tokenSalt` matches only `CurvePadFactory.sol` in the whole launchpad tree. The non-zero branch at `:273` has no test: not that a mined salt yields the predicted address, not salt reuse, not two callers colliding, not a pre-initialized pool. Contrast `pad-v4/test/helpers/brand.js` + `pad-v4/contracts/test/ArrowLauncherSaltBound.sol`, built to measure exactly this. Note: the two attack scenarios written into that finding would both *pass* on first write (a duplicate salt does revert in CREATE2, and an un-squatted retry does succeed) — file it as coverage, not as a vulnerability.

---

### Untidy — nothing lost, but three documents assert a falsehood about a 10% cut

**5. MEDIUM — the vault's headline trust guarantee is now false, in the contract and in both shipped docs.**
`pad-v4/contracts/presale/PresaleVault.sol:30-31`

Still reads: *"ETH NEVER touches the creator — it leaves the vault only as (a) the pooled curve buy or (b) a refund/claim to the very depositor who put it in."* There is now a third exit: `withdrawPlatformFee()` at `:371-380` pays `IFeeWalletRegistry(...).platformFeeWallet()`. `:302-303` sets `platformFee = totalRaised * 1000 / 10000` and `:399` subtracts it again from the ETH-back pool. `git show efe350e` confirms the header block appears only as unchanged context — first hunk is `@@ -45,6 +46,10 @@`.

`PRESALE-SPEC.md:66-68` made rewriting that sentence an explicit precondition of writing the fee. The fee shipped; the sentence did not change. Worse, `PRESALE-SPEC.md:55` repeats the false invariant and `:60-64` still files the 10% under **"## 3. Decided, not yet built — Nothing takes a fee anywhere in the presale today."** `PADS-EXPLAINED.md:123`, under the heading "Where the money goes," repeats it verbatim.

Calibration: the literal clause "never touches the *creator*" is still true — the platform is not the creator. What is false is the exhaustive "only as (a) or (b)". And `:33`'s "no owner, no admin, no operator" is true of the *vault* but omits that the 10% destination is chosen by `FeeWalletRegistry`'s `Ownable2Step` owner, which `FeeWalletRegistry.sol:12` itself calls "the protocol's ROOT ADMIN KEY". The fee *is* disclosed in the same file at `:49-52` — so the contract contradicts itself rather than concealing anything. Not deployed yet, so nobody has been misled. But `:50-51` explicitly invites a contributor to "read the terms off the bytecode," and the terms they read are wrong.

**6. LOW — `claim()`'s NatSpec now documents `withdrawPlatformFee()`, and `claim()` has none.** `pad-v4/contracts/presale/PresaleVault.sol:366`. `efe350e` inserted the new function *between* `claim()`'s doc comment and `claim()`. Confirmed by compiling with the pinned `solc 0.8.26+commit.8a97fa7a`: userdoc for `withdrawPlatformFee()` comes back as `"Pull your pro-rata tokens (+ pro-rata refund of unspent ETH). One-shot.Pay the platform's accrued cut…"` (solc concatenates duplicate `@notice` with no separator, no warning), and `claim()` is absent from userdoc entirely. That string is in the metadata hashed into the deployed bytecode, so it renders on Sourcify/Blockscout verified source. A contributor calling it pays gas and gets nothing — and `:373` `return`s silently rather than reverting, so there is no error to signal the mistake. Fix is moving one line down to `:381`.

**7. LOW — nothing outside the test suite can collect the accrued fee.** `withdrawPlatformFee` appears only at `PresaleVault.sol:371` and in `pad-v4/test/sim/presale.sim.test.js`. Not in `pad-v4/pad/lib.js:88-97`, not in any script, not in `DEPLOY.md`, not in `scripts/keeper.js` (which walks `launches[]` only). Enumeration exists on-chain (`PresaleVaultFactory.presales[]`, `presaleCount()`), so the fix is a ~5-line loop in the keeper — the ETH is never at risk, the function is permissionless and has no deadline. But the default outcome of shipping as-is is that the fee accrues and is never taken.

**8. LOW — `pad/assets/config.js:28` still hands every user's wallet the endpoint that 429s.** `walletRpcUrls: ["https://robinhoodchain.blockscout.com/api/eth-rpc"]`, consumed at `pad/assets/wallet.js:361` in `wallet_addEthereumChain`. I probed it: three consecutive `eth_blockNumber` POSTs each returned 429 on the *first* request, `x-ratelimit-limit: 0`, `bypass-429-option: no_bypass`. Six lines above, `config.js:20-22` says of that exact URL "it rate-limits (429) every browser and ethers then retries it forever." `https://rpc.mainnet.chain.robinhood.com` returns 200, serves `access-control-allow-origin: *`, accepts `eth_sendRawTransaction`, and `launchpad/scripts/grad-keeper.js:53` already broadcasts through it. One-line fix. Presents to users as "the pad is broken," not as rate limiting. Also stale in `pad/docs.html:221`, `docs/gitbook/network.md:10`, `docs/src/network.md:10`, `docs/mintlify/network.mdx:15`, `sdk/robinlabs.mjs:20`.

**9. LOW — `PresaleVault.sol:96-98` states a mechanism `_payout` does not have.** Says `platformFee` must never be zeroed "because `_payout` divides the leftover ETH by it." `_payout` at `:399` *subtracts* it; the divisor is `totalRaised`. The conclusion is right and load-bearing (zeroing it would over-pay every unclaimed contributor until the last one reverts), but a guard whose stated reason fails a five-second check is a guard that gets "simplified" away. Same wrong wording at `pad-v4/test/sim/presale.sim.test.js:323`.

**10. NOTE, no fix — floor-rounding dust.** `_payout` floors both legs (`:397`, `:399`), leaving up to n-1 wei and n-1 token units permanently in the clone. Reproduced: 3 depositors × 1 ETH left 1 token unit on a deep curve, 2 wei on a shallow one. Direction is always safe — floors never over-pay, the vault is solvent against every claim plus the fee at any ordering. `presale.sim.test.js:287-289` already codifies it as acceptable. Adding a sweep would inject a privileged value-mover into a contract whose whole claim is "no owner"; don't.

**Verified negative, recorded so nobody re-runs it:** M-1 holds under the fee. `_absorbableIn` (`:348-362`) is byte-identical, `amtIn = min(absorbable, buyBudget) ≤ min(absorbable, totalRaised)`, so the hook can never bill un-executed ETH. `pooledEthSpent ≤ amtIn ≤ buyBudget` makes `:399` underflow-proof and vault balance covers `sum(ethBack) + platformFee` with only flooring dust. `platformFee` is assigned at `:302`, strictly after the sniped-launch `return` at `:272`, so every failure path refunds 100%. M-12, M-22, L-12, L-13, L-20, L-21 mechanically untouched. 16 tests pass.

---

## PART 2 — DESIGN: presale → v3

**Recommendation: Design C — `PresaleVaultBase` + two thin venue adapters + one factory with two typed entrypoints.** With four grafts from A and B, listed below.

### Why C wins

**The decisive fact is that A and B both route the pooled buy through `PadRouter.buy`, and that leaks contributor ETH to the creator.** `launchpad/contracts/PadRouter.sol:391` credits `devEscrow[token] += toCreator`; `launchpad/contracts/FeeConfig.sol:34` defaults `swapCreatorBps = 4500`; `launchpad/scripts/deploy.js:70` already called `setFeeConfig` on the live router `0xA6BaAB82`, so that branch is the live branch. `devEscrow` drains via the permissionless `withdrawDev` (`PadRouter.sol:463-470`) to `_cfg[token].projectWallet` = the creator.

Quantified: a 100 ETH presale → 90 ETH buy budget → at the *minimum* allowed `buyBps` of 100, fee is 0.9 ETH → **0.405 ETH of contributor money lands in the creator's escrow.** At the 400 bps cap it is 1.62 ETH. `register()` forbids `buyBps < 100`, so there is no vault-side setting that makes it zero, and `feeConfig` is a live governance knob the vault has no say over. This is a direct, quantified violation of the presale's single hardest constraint. Design A found it and offered the direct-swap escape as an afterthought in its risk list; Design B did not notice it at all and shipped `IPadRouter(buyTarget).buy{value: amtIn}` as its v3 branch.

C routes through `CurvePadFactory._devBuy` instead (`launchpad/contracts/CurvePadFactory.sol:306-336`), which swaps the pool **directly**: no router, no buy fee, no 0.25% reward leg, no creator leak. It already price-caps at the graduation ceiling (`:311-312`) and already refunds unspent WETH as ETH (`:324-329`) — which is exactly the M-1 over-tax property that `_absorbableIn` needed 25 lines to approximate in v4, here exact and on-chain. The single blocker is that `:299` sends proceeds to `p.dev`; C's fix is one new `LaunchParams.buyTo` field, zero meaning `p.dev` (behaviour identical to today). Two lines, in a factory that is not yet deployed.

**Second reason: C is the only design that keeps the money path audited once.** A ships a full copy of the vault — every future fee or refund change has to land twice, and the copy diverges the first time someone patches one and not the other. B abstracts the *venue* behind `IPadLauncher`, which relocates four already-closed findings (M-1 `_absorbableIn`, M-12 geometry snapshot, the FDV precheck, `KeyMismatch`) out of the vault into `V4Launcher` — re-opening them for zero v4 benefit. B's own author says so and recommends the base-class variant, which is C. C moves the money path into `PresaleVaultBase` unchanged, and the existing v4 suite (`presale.sim.test.js`, `M1.presale-overtax.test.js`) passing with only its deploy line changed is the gate that proves the extraction was mechanical.

**Third: C correctly identifies that the v4 `Failed(3)` classifier must not be ported.** v4's `[L-12]` rule at `PresaleVault.sol:270` treats empty revert data as out-of-gas and bubbles, because v4 collisions surface as typed errors. In v3 the collision is `new LaunchToken{salt: s}` at `CurveDeployers.sol:93` and CREATE2 failure reverts with **empty** data — the exact inverse. A ported classifier would misread a genuine squat as OOG. A solves it with an `expectedToken.code.length` pre-check, B with a `launchable()` typed probe, C by deleting the heuristic entirely and bubbling. C's answer is the cheapest correct one: after the reveal-first check, every remaining revert *is* retriable, and `fail()` reason 2 is the 100%-refund backstop. Cost is that a sniped presale waits out the grace window instead of refunding instantly — acceptable, but the presale page must say so rather than reusing v4's copy.

### Grafts from the runners-up

1. **From B — pre-empt the pool at `createPresale`.** This is the best idea in any of the three, and it also closes audit finding #2 for standalone launches. A presale publishes name/symbol/dev/supply/tick for up to 90 days, and `[M-22]` says a single reverted `finalize` publishes the salt forever. Anyone who computes the token address can then `createPool(predictedToken, WETH, 10000)` + `initialize(offGrid)` and kill the raise permanently via `CurvePool.sol:157`. Fix: the creator supplies the predicted token address as a **public, non-secret** parameter (publishing an address leaks nothing about the salt), and `initialize()` immediately does `createPool` + `initialize(wantSqrt)` in the same tx, occupying the pool at the *correct* price. `CurvePool`'s constructor then takes its `existingSqrt == wantSqrt` accept branch at `:154-158` and the brick is unreachable. The same `predictedToken` doubles as a bait-and-switch guard: `if (token != predictedToken) revert TokenMismatch()`.

2. **From A — bound `target` against real curve capacity.** The 10% is charged on the whole raise (`:302` computes off `totalRaised`, not `pooledEthSpent`) and that is fixed. But the default v3 curve absorbs only ~4.2 ETH before the graduation ceiling and only 75% of supply is on it (`AMBUSH_BPS = 2500`). A 50 ETH target means ~45.8 ETH is refunded pro-rata *after* the platform has already taken 5 ETH — contributors pay 10% on money that never bought anything. Compute capacity exactly from `PoolMath.singleSidedLiquidity` + `getAmount0/1ForLiquidity` (already in `launchpad/contracts/libraries/PoolMath.sol`), expose it as a view, and `require` at `initialize`. One view, one require, ~25 lines. Without it this is a live product footgun.

3. **From A — measure `MIN_FINALIZE_GAS` on a fork before writing any vault code.** `finalize` = launch + pooled buy in one tx under a 2^24 = 16,777,216 cap. `CurvePool.seed()` alone burns ~4M on `increaseObservationCardinalityNext(200)` (`CurvePool.sol:181-186`, whose own comment says a bigger bump would push `launch()` over the cap), and `launchpad/test/fn-gas-cap.test.js:51` only asserts launch+devbuy under 80% of cap (13.4M). It very likely fits — the presale buy *is* the dev buy, same swap — but a ~14M floor against a 16.77M ceiling with EIP-150's 1/64 already taken leaves almost no margin. **If it doesn't fit, the design is dead**: splitting `finalize` into two txs puts the fresh curve on-chain one block before the contributors' buy, and every bot front-runs them. There is no safe fallback. Answer this first, in a couple of hours, before anything else is written.

4. **From B — reject `tokenSalt == 0` at `initialize`.** `CurvePadFactory` treats zero as "factory picks entropy," but a presale committing to a zero salt has a publicly computable commitment preimage — `finalize` becomes callable by anyone the instant the target is met, with no reveal at all.

### One interaction the designs missed

The critical fix in audit #1 is to bind the salt to `msg.sender` at the factory. On the presale path `msg.sender` is the **vault**, and `PresaleVaultFactory.sol:54` uses `Clones.clone` — nonce-based CREATE, so the vault address is not knowable before the `createPresale` tx lands, and the creator cannot mine `tokenSalt` against it. Switch to `Clones.cloneDeterministic` with a creator-supplied clone salt so the vault address is predictable, then mine `tokenSalt` against `keccak256(vault, tokenSalt)`. This must be settled in the same commit as the factory salt fix, or presales lose address mining entirely.

Also: keep the commitment at three words (`keccak256(abi.encode(tokenSalt, hookSalt, curveSalt))`) for both venues, with the last two unused on v3. That keeps the reveal check a single shared line in the base. Ship **one** commitment helper — a creator tool that commits `keccak(abi.encode(salt))` instead of `keccak(abi.encode(salt, 0, 0))` produces a commitment that can never be satisfied, and a raise that can only ever reach `fail()` reason 2.

### Ordered list of changes

**Phase 0 — unblock (do before anything else)**

1. Fork-measure `finalize` = launch + `_devBuy` gas against 2^24. If it does not clear ~15M with headroom, stop and re-argue the anti-snipe property before writing a line.
2. Fix the `tokenSalt` critical: `CurvePadFactory.sol:272` → `keccak256(abi.encodePacked(msg.sender, p.tokenSalt))`. Delete the false comment at `:262-271`.
3. Fix the pool-brick: in `CurvePool`'s constructor (`:153-158`), on a squatted pool do a zero-liquidity swap to `wantSqrt` instead of reverting `BadPoolInit`.
4. Repair the red suite: add `tokenSalt` to the ~16 `LaunchParams` call sites (start at `launchpad/test/fdv-supply.test.js:48`). Add the four missing coverage cases for the non-zero branch: mined salt → predicted address; two callers, same salt; pre-init pool; salt reuse.
5. Bump the four stale ABIs — `sdk/robinlabs.mjs:69`, `launchbot/config.js:28`, `pad/assets/config.js:136`, `pad/docs.html:402` — and coordinate the cutover with `deploy-v2.js`, or every launch path reverts the moment the new factory is live.

**Phase 1 — doc corrections (30 minutes, no code)**

6. `pad-v4/contracts/presale/PresaleVault.sol:30-31` — rewrite to three exits; qualify `:33` to name the registry-governed fee destination.
7. `PRESALE-SPEC.md:55` and `:60-64` — move the 10% out of "Decided, not yet built" into "built today."
8. `PADS-EXPLAINED.md:123` — same sentence, plus a presale row in the FEE CHEAT SHEET at `:190-200`.
9. `PresaleVault.sol:366` — move the orphaned `@notice` down to `:381`, above `claim()`.
10. `PresaleVault.sol:97` — "subtracts it from the leftover ETH," not "divides by it." Same at `presale.sim.test.js:323`.
11. `pad/assets/config.js:28` — `walletRpcUrls` → `https://rpc.mainnet.chain.robinhood.com`. Same in `pad/docs.html:221` and the four docs files.
12. Add a presale step to `scripts/keeper.js` over `presaleFactory.presaleCount()` so the accrued fee actually gets collected.

**Phase 2 — the presale build**

13. `CurvePadFactory.sol` — add `address buyTo` to `LaunchParams` (`:79-88`); route `:299`'s `_devBuy` recipient through it (`p.buyTo == address(0) ? p.dev : p.buyTo`). Add `buyTo` to the `Launched` event at `:120` so indexers don't mis-attribute the presale buy as a dev buy. Comment `_devBuy` to say the presale depends on its leftover-WETH refund.
14. `pad-v4/contracts/presale/PresaleVaultBase.sol` — NEW. Extract ~330 lines from `PresaleVault.sol` **verbatim**, zero logic edits: constants, storage, events, errors, `deposit`, `fail`, `refund/refundTo/_refund`, `claim/claimTo/_claim`, `_payout`, `previewClaim`, `withdrawPlatformFee` (wallet lookup swapped for `_platformFeeWallet()`), plus the shared `finalize()` and `_initBase()`. Three abstract functions are the whole venue seam: `_preflight()`, `_launchAndBuy()`, `_platformFeeWallet()`. `pooledEthSpent` is **measured** as a balance delta, never reported by the adapter.
15. `pad-v4/contracts/presale/PresaleVaultV4.sol` — NEW. What's left of today's vault: `unlockCallback`, `_absorbableIn`, the M-12 geometry snapshot moved into `_preflight()`, the launch try/catch moved into `_launchAndBuy()`. Delete `PresaleVault.sol`.
16. `pad-v4/contracts/presale/PresaleVaultV3.sol` — NEW, ~90 lines. `LaunchParamsV3` ABI mirror, `_preflight()` (FDV band + `router.isFactory`), `_launchAndBuy()` calling `launchWithSupply{value: buyBudget}` with `buyTo = address(this)`, flag-gated `receive()`, `_platformFeeWallet() = padFactory.platform()`. `initialize()` rejects `tokenSalt != 0`, `buyTo != 0`, `dev == 0`, `mag % 200 != 0`, `mag + CURVE_WIDTH > 887200`, FDV out of band, `buyBps/sellBps` outside [100,400], `wallet+floor+burn != 10000` — the L-21 precedent, so a config `launch()` will always reject can never take deposits for 90 days. Plus graft 2: `require(target <= curveCapacity())`.
17. `PresaleVaultFactory.sol` — `createPresaleV3` / `createPresaleV4` (two typed entrypoints, not an enum + `abi.decode` blob), shared `presales[]` registry, `Clones.cloneDeterministic`, and graft 1: call `preemptPool(predictedToken)` in the same tx on the v3 path.
18. Tests, in this order: (a) the existing v4 suite passes with only its deploy line changed — if any assertion moves, the extraction was not mechanical, stop; (b) `V3.presale-invariants.test.js` — **`devEscrow[token] == 0` and creator balance unchanged across a full finalize at `buyBps` 100 *and* 400**; buy overshoots the ceiling → refund lands in the vault, ETH-back correct; CREATE2 collision → reverts empty, presale stays open, `fail(2)` refunds 100%; `setFdvBand` out of band → `GeometryChanged`, presale stays open; `receive()` reverts for an unsolicited sender; `dev == creator` after finalize (`CurvePool.dev` is immutable and carries the 0.5 WETH graduation reward at `CurvePool.sol:320` — never set `dev = vault`); (c) `presale.v3.fork.test.js` against the real deployed `PadRouter 0xA6BaAB82` / `LaunchTokenDeployer 0xb3748cB6` — the only thing that catches a drift between `LaunchParamsV3` at solc 0.8.26 and `LaunchParams` at 0.8.24+viaIR, which a mock will happily agree with.
19. `deploy-v2.js` + `DEPLOY-V2.md` + `PRESALE-SPEC.md` §3 — two implementations, one presale factory wired to both pad factories, the salt-mining prerequisite, and the corrected mechanism (the spec's "PadRouter.buy() does the swap" sentence is wrong; the no-callback conclusion is right).

**Effort:** ~1 week to review-ready, plus ~3 days of re-audit. The re-audit is not a delta review — the base extraction touches every line of an already-audited money path and needs a full re-read. Net new Solidity is small (~90 lines of v3 adapter, 2 lines of factory, ~40 of plumbing), which is the point: the 10% fee, the 100% refund, the pro-rata payout and the commit-reveal are **moved, not re-implemented**.
