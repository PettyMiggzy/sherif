# Coin site templates

Per-launch websites for Robin Labs coins. The idea: every coin launched on the pad can get its
own polished website at `<ticker>.robinlabs.fun` (a single wildcard subdomain covers all of them,
unlimited, at no per-coin cost). The creator picks a style and fills a short form; the site renders
itself from that data plus live chain data. No per-coin build, no per-coin domain.

The showcase coin is **$ROBIN** (the Robin Labs flagship), so the default anyone sees is the home
team, rendered from its real on-chain data (7.20 ETH mcap, 15.2 ETH volume, 9,306 trades, 61% up
its bonding curve).

## The 10 styles

| File | Style | Feel |
|------|-------|------|
| `neonvault.html`    | Neon Vault      | Deep charcoal, one lime accent, oversized display. Bold launchpad brand. |
| `aurora.html`       | Aurora Glass    | Frosted glass over a slow animated aurora. Apple-keynote calm. |
| `midnight.html`     | Midnight Terminal | Black, monospace, phosphor-green live ticker, scanlines. Trader-native. |
| `blackgold.html`    | Blackgold       | Near-black and gold foil, elegant serif. Luxury house. |
| `chromesunset.html` | Chrome Sunset   | Synthwave horizon + perspective grid, chrome type. Retro-futurist. |
| `cyberhud.html`     | Cyber HUD       | Magenta/cyan HUD frames, telemetry readouts. Control panel. |
| `reserve.html`      | Reserve         | Light, serif headlines, wide whitespace. Institutional. |
| `brutalist.html`    | Brutalist Ink   | Heavy grotesque, hard rules, one red. Print-poster. |
| `halftone.html`     | Halftone Pop    | Comic outlines, halftone dots, speech panels. Playful. |
| `monomax.html`      | Mono Max        | One accent, enormous type, near-zero chrome. Gallery-minimal. |
| `index.html`        | Switcher        | Flip between all 10 in one page. |

`examples/broke.html` is a second coin (the real `$BROKE` launch) rendered in a bespoke
overdraft/receipt theme, to prove the engine themes any coin, not just the flagship.

## How to review

- Open `index.html` and use the pills to switch styles, or open any single template directly.
- On this branch's Vercel preview deploy: `/<preview-domain>/templates/coin-site/`.
- Every file is fully self-contained: the coin logo is inlined as a data URI and there are zero
  external requests (works offline, safe under a strict CSP).

## Design rules baked in

- No stock imagery. The only bitmap is the coin's own logo. Everything else is pure CSS, inline
  SVG, or Canvas. Generated hero art (optional) would route through Venice, never stock libraries.
- No emoji, no em-dashes.
- Each template commits to one premium visual identity and is responsive down to a phone.
- Verified: each renders in a real browser with no console errors, machine-scanned for external
  requests / emoji / em-dashes, and passed a design-director critique + refine pass before landing.

## Not wired yet (next steps)

- Wildcard routing on `robinlabs.fun` (Vercel) so `<ticker>.robinlabs.fun` resolves to the matching
  coin, with a slug wordlist filter, reserved-word block, and takedown blocklist.
- The short "site builder" form (an extension of the existing coin profile editor) with the style
  picker, so the baked-in demo values become variables filled from each coin's signed profile.

Preview only. Nothing here is wired into the live pad; it lives on the feature branch for review.
