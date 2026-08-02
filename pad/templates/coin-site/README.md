# Coin sites — `<ticker>.robinlabs.fun`

Every coin launched on Robin Labs can claim its own live website at
`<slug>.robinlabs.fun`. One wildcard subdomain covers all of them — unlimited,
no per-coin build, no per-coin domain, no per-coin cost. The creator picks a
style and a subdomain in a short form; the page renders itself from the coin's
**real on-chain data** (market cap, volume, trades, curve progress) plus the
creator's profile (logo, description, socials).

The flagship **$ROBIN** is the showcase, but the exact same engine themes any
coin — see `examples/broke.html` (the real `$BROKE` launch, overdraft theme).

## How it works (data flow)

```
visitor → broke.robinlabs.fun/
        → Vercel rewrite (pad/vercel.json, host = *.robinlabs.fun) → /site.html
        → site.html reads the subdomain "broke"
        → GET https://api.robinlab.io/api/site/broke   → { coin, style }
        → GET /templates/coin-site/<style>.html        → the chosen template
        → CoinSite.render(template, coin)              → filled HTML
        → document.write(...)                          → the live coin site
```

- **Engine:** `pad/assets/coinsite.js` — the ONE data-driven renderer. It maps
  the API's `shapeCoin` object + profile onto the template placeholders, escaping
  every value. Used by the serve page, the form preview, and the tests.
- **Templates:** the 10 `*.html` files below, each a self-contained document with
  `{{TOKEN}}` and `<!--IF:x-->` markers. Contract: `ENGINE.md`.
- **Serve page:** `pad/site.html` — the wildcard target. Resolves the slug, fetches
  data + template, renders, and handles not-found / taken-down / preview states.
- **Creator form:** `pad/website.html` — connect wallet → pick style → claim slug
  (live availability) → live preview → one signature → published.
- **Indexer:** `POST /api/coin/:token/site` (creator-signed) stores style + slug;
  `GET /api/site/:slug` resolves; `GET /api/site/available/:slug` checks a slug.
  Moderation in `indexer/src/sitegate.js` (format + reserved words + wordlist +
  takedown blocklist). Slug column is UNIQUE.

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
| `index.html`        | Switcher        | Flip between all 10 in one page (static preview). |

## Deploying the wildcard (one-time, in Vercel)

The code is ready; adding the domain is the only manual step:

1. In the **pad's** Vercel project (root directory `pad/`), add the domain
   `*.robinlabs.fun` (wildcard). Vercel will show the DNS record to add at your
   registrar (a `CNAME *` → `cname.vercel-dns.com`, or the ALIAS Vercel gives you).
2. `pad/vercel.json` already contains the host-conditioned rewrite that turns any
   `<slug>.robinlabs.fun` request into `/site.html`. Nothing else to configure —
   `robinlab.io` is unaffected (the rewrite only fires on the `*.robinlabs.fun` host).
3. That's it. A creator opens `robinlab.io/website.html?c=<their coin>`, picks a
   style + slug, signs once, and their site is live at `<slug>.robinlabs.fun`.

> If the pad is instead deployed from the repo root (pad served as a subpath),
> move the `rewrites`/`headers` blocks from `pad/vercel.json` into the root
> `vercel.json` and prefix the destinations with `/pad` (`/pad/site.html`).
> `site.html` also falls back to fetching the engine + templates from
> `https://robinlab.io/...` so it renders regardless of the exact mount.

## Moderation & takedowns

- **Reserved words** (infra + first-party + phishing targets like `robinhood`,
  `uniswap`, `airdrop`) are refused. **Format:** 2–32 chars, `[a-z0-9-]`, no
  edge/double hyphens. **Wordlist:** a built-in rot13'd slur/abuse list; extend
  with `SITE_SLUG_BLOCKWORDS` (extra substrings).
- **Takedown:** put a slug in `SITE_SLUG_BLOCKLIST` (env) — it's refused at both
  registration and serve time (HTTP 410), so `shit.robinlabs.fun` can be pulled
  even after the fact. A creator can also self-remove their site from the form.

## Design rules baked in

- No stock imagery. The only bitmap is the coin's own logo (or a generated
  monogram when it has none). Everything else is pure CSS / inline SVG.
- No emoji, no em-dashes. Each template commits to one premium identity and is
  responsive to a phone. Zero external requests beyond the coin logo + data.
