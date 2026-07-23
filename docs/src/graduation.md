# Graduation — one ceiling, one line

Graduation is a **single point**, not a window. A coin graduates at exactly one price: the top of its curve — the ceiling (`gradTick`), reached at **~4.2 ETH raised / ~$34k mcap** (FDV). It starts life at **~$3.4k FDV** and climbs the curve buy by buy until it hits that ceiling.

| Parameter | Meaning | Set by |
|-----------|---------|--------|
| `startTick` | Curve start (~$3.4k FDV) | Fixed at launch |
| `gradTick` | The ceiling (~$34k FDV). Buys can't push past it, and it's the *only* price that graduates | Fixed at launch |
| `ready()` | True only once the pool tick reaches `gradTick` | Read-only |

There is **no early graduation, no creator-settable target, and no timeout.** `ready()` flips to true only when the pool tick reaches the ceiling. Below the ceiling the coin simply keeps trading on the curve — and because every buy adds real WETH, a seller can always exit at the going price. The only thing `graduate()` does is post the floor once the curve is full.

On graduation the curve collects the raised WETH + unsold tokens, pays the **creator 0.5 ETH and the platform 0.5 ETH** (each capped at a quarter of the raise), and posts the **rest (~3.2 ETH)** as the Bond: the Sherwood full-range LP, the Bounty WETH floor, and the Ambush token wall. `graduate()` is **permissionless** — anyone can call it the moment `ready()` is true (the pad's "Graduate" button, or a keeper bot).

## The Bond — three positions

The raise is split **60% Sherwood full-range LP / 40% Bounty floor**, plus the Ambush token wall.

| Position | What it is |
|----------|-----------|
| **Sherwood** | A full-range Uniswap v3 LP, locked forever. Its trading fees compound back into itself via `poke()`. Takes 60% of the raise. |
| **Bounty** | A concentrated WETH buy-wall *below* spot — a floor that bids on every dip. Takes 40% of the raise; deeper with volume. |
| **Ambush** | The 25% token reserve + unsold curve tokens, posted as a sell-wall *above* spot. |

The curve geometry is fixed by calibration constants — `START_TICK_MAG=201600`, `CURVE_WIDTH=23000`, `MIN_GRAD_WIDTH=22800` — so every coin launches with the same shape and the same ceiling distance.

## Anti-rug by construction

The ceiling is the only price that graduates, and it's the top of the curve — the only unbacked price zone above it never exists. Anywhere inside the curve, moving price up costs real WETH that *joins* the raise, so by the time a coin graduates the floor has been fully paid for and always sits below spot. There's no lever to graduate a coin early against a thin floor: the curve has to be filled to the ceiling first, and filling it *is* the raise.
