# $SHERIFF — Sheriff of Nottingham

Official landing site for **$SHERIFF**, the Sheriff of Nottingham meme coin on
**Robinhood Chain**. He takes from the poor and feeds his greed — the taxman with
a castle, ridden onto the chain of the company named after his oldest enemy.

> Takes from the poor. Feeds his greed.

## Stack

Zero-build static site — plain HTML, CSS, and vanilla JS. Deploy anywhere
(GitHub Pages, Netlify, Vercel, Cloudflare Pages, an S3 bucket…).

```
index.html      # single-page site
styles.css      # clean dark UI system (warm-black + lime #ccff00 + gold), Bebas Neue + Plus Jakarta Sans
script.js       # mobile nav, copy-contract, scroll reveals, animated counters, donut fill
assets/brand/   # brand art + intro video (web-optimized WebP / MP4)
assets/logo.svg # shield-arrow mark / favicon
game/art/       # transparent character sprites — prep for the "Tax Heist" mini-game (roadmap)
```

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Design

Clean, minimal, cinematic. Warm near-black background, bright lime `#ccff00`
accent, gold secondary, soft 1.5–2rem rounded corners, subtle translucent
borders, and lots of whitespace — Bebas Neue for display, Plus Jakarta Sans for
body. Interactive touches: animated grid/glow background, a live badge, a scroll
gallery, an SVG donut for tokenomics, and a vertical timeline roadmap.

## Sections

Hero · The Legend (real history) · He Keeps All the Taxes · The Coin Flipped
Twice (the Robinhood irony) · Meet the Sheriff (emotes + quotes) · The Cast
(Disney's 1973 animal ensemble) · Gallery + intro video · Tokenomics · How to
Buy · Roadmap · Community.

## Lore — grounded, not made up

The narrative is built on verified public sources:

- **Sheriff = shire-reeve**, the king's county tax collector; the High Sheriff of
  Nottinghamshire (from 1068) held Nottingham Castle and enforced Sherwood's
  forest law.
- The Sheriff is Robin Hood's archetypal enemy precisely *because* his job was
  collecting taxes and hunting outlaws. In the oldest ballads he has no name.
- **Philip Marc**, a real sheriff under King John, was named personally in
  **Magna Carta (1215)** for removal.
- **Disney's Robin Hood (1973)** casts the tax plot with animals — Robin (fox),
  the Sheriff (wolf), Prince John (lion), Sir Hiss (snake), Little John (bear),
  Friar Tuck (badger), Maid Marian (vixen), Trigger & Nutsy (vultures).
- **The modern irony:** the brokerage Robinhood is named after Robin Hood ("for
  the little guy") yet is accused of playing the Sheriff (payment-for-order-flow,
  the 2021 GameStop halt). Robinhood Chain launched July 2026 and its first hit
  activity was meme coins — so a "Sheriff of Nottingham" coin that *keeps all the
  taxes* is the punchline the ecosystem wrote itself.

## Editing content

- **Contract address** — set it in `index.html` inside `<code id="ca">` at launch.
- **Socials** — replace the `#` links (footer + community section) with real X /
  Telegram URLs.
- **Art** — brand images live in `assets/brand/`. Reference art was provided by
  the project; supplemental art/video was processed for web (WebP + a compressed
  MP4 intro).

## Disclaimer

$SHERIFF is a community meme coin for entertainment only — no intrinsic value or
expectation of financial return. **Not affiliated with, endorsed by, or connected
to** Robinhood Markets, Inc., The Walt Disney Company, or any historical office.
Crypto is risky — do your own research.
