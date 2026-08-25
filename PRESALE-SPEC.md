# Presale — what is built, what you decided, what is still blank

Working doc. Read the corrections before spec'ing anything on top of this.

## 1. Corrections to the record

**`MIN_TARGET = 0.01 ether` is a FLOOR, not a ceiling.** Targets above it are already
unlimited — a creator can set 5 ETH, 50 ETH, or 500 ETH today. Nothing changed and nothing
needed to. The open question is the opposite one: do you want to *forbid* presales under
5 ETH? That blocks small creators, so it is a real product call, not a bug fix. Left at
0.01 pending your answer.

**The graduation split is not what you remembered.** `SHERWOOD_WETH_BPS = 6000`:

| | |
|---|---|
| Raise at graduation | ~4.2 ETH |
| Creator reward | 0.5 ETH (capped at raise/4) |
| Platform reward | 0.5 ETH (same cap) |
| Remaining | ~3.2 ETH |
| → LP | 60% = **~1.92 ETH** |
| → floor buy wall | 40% = **~1.28 ETH** |

You said "0.2 to ambush, other 3 ETH is the LP". It is ~1.92 LP / ~1.28 floor, and the
ambush is a TOKEN-side sell wall, not an ETH allocation. If you wanted ~3 ETH in LP,
`SHERWOOD_WETH_BPS` has to move — say so and it moves.

**Everything else you said checks out:**

| Your recollection | Code | ✓ |
|---|---|---|
| swap fee 45 creator / 45 platform / rest floor | `swapCreatorBps 4500`, `swapPlatformBps 4500`, `swapFloorBps 1000` | ✓ |
| platform takes the ETH side of LP | curve phase `_splitFee(WETH, fees, 0)` = 100% platform; token side is 90/10 via `lpCreatorBps` | ✓ |
| 0.5 ETH each to creator and platform at graduation | `GRAD_REWARD = 0.5 ether` | ✓ |

**Refund gas is already not your problem.** Each depositor calls `refund()` and pays their
own gas. There is no mass-refund transaction for the platform to fund. If that was part of
why you wanted the 10%, the 10% does not need to carry it.

## 2. What is built today (v4 only)

One `PresaleVault` per presale, EIP-1167 clone.

1. Creator opens: target (= hard cap), deadline, per-wallet cap, min contribution, finalize grace
2. Anyone deposits ETH — no whitelist
3. Target hit → `finalize()` launches the coin AND does the pooled buy atomically, one tx
4. Depositors claim tokens pro-rata at the resulting curve price, plus a pro-rata refund of
   ETH the buy did not spend
5. Target missed by deadline → `fail()` → 100% refunds, no claim deadline
6. `finalize` never called within grace → converts to Failed, refunds open

Bounds: target ≥ 0.01 ETH, duration 1 hour – **90 days** (raised from 30 on your call),
grace 1 hour – 7 days.

Trust model: no owner, no admin, no operator. ETH leaves the vault only as the pooled buy or
as a refund to the wallet that deposited it. Launch salts are commit-reveal so the pool
cannot be sniped before it exists; if someone lands the launch first the presale marks
itself Failed and refunds open. It cannot brick and cannot be drained.

## 3. Decided, not yet built

**10% of the raise to the platform.** Nothing takes a fee anywhere in the presale today —
not to open one, not on the raise. This is the largest gap between the code and the product
you described.

It needs one decision before it can be written, because it breaks a promise the contract
currently makes in its own header — *"ETH NEVER touches the creator"* — and the honest
version of that promise has to change with it:

- **Taken at finalize, off the top.** 10% to the platform, 90% into the pooled curve buy.
  Depositors' refunds stay 100% on failure, because nothing is taken until the raise
  succeeds. Cost: the coin launches with 10% less liquidity than the raise implies, and the
  presale page has to say so plainly.
- **Taken on deposit.** Do not. It makes a "100% refund" false, which is the strongest thing
  the design currently offers.

Recommend the first. It is one branch in `finalize()`, it keeps every failure path exactly
as audited, and it is honest to state.

**Both pads.** v3 and v4, creator picks. The vault is currently hard-wired to v4 — it calls
the v4 factory and swaps against the v4 PoolManager directly. v3 needs a launcher adapter;
it is the simpler of the two because `PadRouter.buy()` does the swap, so no unlock callback
and no pool math in the vault.

## 4. Blanks

- **Minimum target** — leave at 0.01 ETH, or raise it to 5 and block small presales?
- **Soft cap** — target is currently also the hard cap, so a raise cannot overshoot. Do you
  want to raise past target?
- **Creator allocation** — you want creators to airdrop supply after launch. Today the
  creator receives NO tokens at finalize; everything goes to depositors pro-rata. An airdrop
  needs an allocation that does not exist. How big, and does it vest?
- **`SHERWOOD_WETH_BPS`** — leave at 60/40, or move it toward the ~3 ETH LP you described?
- **The sell-side routing** you mentioned (30% staking / 30% dev treasury) does not match
  what I can find in the code, and I am not going to write it down from either of our
  memories. Needs a pass against `RobinTokenTreasury` before it goes in a spec.

## 5. Already exists, no work needed

**Airdrop.** `pad/disperse.html` is live, backed by `Disperse.sol` at
`0xBF2904b4e31F751441C85590EDF10D8a592A9a38`. It already does CSV upload and paste, and it
is non-custodial. What does not exist is a link from "my presale finalized" or "my coin
launched" into that page — which is UI wiring, not a new contract.
