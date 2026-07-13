# $SHERIFF — Sheriff of Nottingham

The official landing site for **$SHERIFF**, the Sheriff of Nottingham meme coin
launching on **Robinhood Chain**. He taxes the peasants, he rides the black
carriage — but this time the community holds the sack.

## Stack

Zero-build static site. Just HTML, CSS, and a sprinkle of vanilla JS — deploy it
anywhere (GitHub Pages, Netlify, Vercel, Cloudflare Pages, an S3 bucket…).

```
index.html      # single-page site
styles.css      # brand styles (lime / gold / forest, Bangers + Fredoka)
script.js       # mobile nav, copy-contract, scroll reveals
assets/         # AI-generated character art + SVG logo
```

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

Push to your default branch, then in **Settings → Pages** pick the branch and the
root folder. The site is fully static, so it works as-is.

## Editing content

- **Contract address** — set it in `index.html` inside `<code id="ca">` once the
  token is live.
- **Socials** — replace the `#` links in the footer with your real Twitter/X and
  Telegram URLs.
- **Art** — all character art lives in `assets/`. It was generated with the
  Venice AI image API (`hunyuan-image-v3`) in a Disney *Robin Hood* cartoon style.

## Assets

| File | Use |
|------|-----|
| `logo.svg` | Shield-arrow mark / favicon |
| `hero-sheriff.webp` | Hero mascot |
| `robin-fox.webp` | Story: the fox |
| `scene-taxes.webp` | Story: collecting taxes |
| `mascot-wave.webp` | Story / footer mascot |
| `coin.webp` | $SHERIFF token coin |

## Disclaimer

$SHERIFF is a community meme coin with no intrinsic value or expectation of
financial return. It is **not affiliated with, endorsed by, or connected to**
Robinhood Markets, Inc. or the Robinhood brand. Crypto is risky — do your own
research.
