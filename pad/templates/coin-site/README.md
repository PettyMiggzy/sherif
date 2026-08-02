# Coin site templates (preview)

Per-launch websites for Robin Labs coins. The idea: every coin launched on the pad can get
its own polished website at `<ticker>.robinslab.fun` (a single wildcard subdomain covers all
of them, unlimited, at no per-coin cost). The creator fills a short form, and the site renders
itself from that data plus live chain data. No per-coin build, no per-coin domain.

## What's here (3 of 10 planned styles)

| File | Style | Feel |
|------|-------|------|
| `midnight.html`  | Midnight Terminal | Black, monospace, phosphor-green live ticker, scanlines. Trader-native. |
| `aurora.html`    | Aurora Glass      | Frosted glass over a slow animated aurora. Apple-keynote calm. |
| `blackgold.html` | Blackgold         | Near-black and gold foil, elegant serif. Luxury house. |
| `index.html`     | Switcher          | Flip between all three in one page. |

Full set planned: Midnight Terminal, Neon Vault, Reserve, Brutalist Ink, Chrome Sunset,
Blackgold, Aurora Glass, Halftone Pop, Cyber HUD, Mono Max.

## How to review

- Open `index.html` and use the pills to switch styles, or open a single template directly.
- On this branch's Vercel preview deploy: `/<preview-domain>/templates/coin-site/`.
- Each file is fully self-contained: the coin logo is inlined as a data URI, and there are
  zero external requests (works offline, and safe under a strict CSP).

## The data these render from

All three are populated from the real `$MILO` (Life of Milo) launch: name, ticker, contract,
story, market cap (2.27 ETH), 24h volume (0.27 ETH), trades (4), and bonding-curve progress
(11%). In production these become variables filled from the coin's signed profile (which the
pad already stores) plus the indexer's live stats, so the same template renders any coin.

## Design rules baked in

- No stock imagery. The only bitmap is the creator's own uploaded logo. Everything else is
  pure CSS, inline SVG, or Canvas.
- No emoji, no em-dashes.
- Each template commits to one premium visual identity and is responsive down to a phone.
- Generated art (optional hero backdrops) would route through Venice, not stock libraries.

## Not wired yet (next steps)

- Wildcard routing on `robinslab.fun` (Vercel) so `<ticker>.robinslab.fun` resolves to the
  matching coin, with a slug wordlist filter, reserved-word block, and takedown blocklist.
- The short "site builder" form (an extension of the existing coin profile editor) with a
  style picker.
- The remaining 7 styles, built on the same data-driven engine.

Preview only. Nothing here is wired into the live pad; it lives on the feature branch for review.
