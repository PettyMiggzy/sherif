# Coin-site template contract

Every `*.html` in this folder is a **data-driven template**: one engine
(`pad/assets/coinsite.js`) fills it with any coin's real on-chain data and serves
it at `<slug>.robinlabs.fun`. A template is a normal, self-contained HTML
document with two kinds of markers baked in.

## Markers

**Value tokens** — `{{TOKEN}}` is replaced with the coin's value. The engine
HTML-escapes every value, so put tokens in **raw** (never pre-escape, never wrap
in quotes you wouldn't otherwise use). Unknown tokens resolve to empty string.

**Conditional blocks** — kept only when a flag is truthy:

```html
<!--IF:telegram--> ...shown only if the coin has a Telegram... <!--/IF:telegram-->
<!--IF:!telegram--> ...shown only if it does NOT... <!--/IF:!telegram-->
```

Flags: `telegram`, `twitter`, `website`, `socials` (any of the three),
`graduated`, `live` (= not graduated), `logo` (coin has a real pfp).

## Tokens

| Token | Value | Example |
|---|---|---|
| `{{NAME}}` | coin name | `Broke` |
| `{{NAME_UPPER}}` | name, upper-cased | `BROKE` |
| `{{SYMBOL}}` | ticker, no `$` | `BROKE` |
| `{{TICKER}}` | ticker with `$` | `$BROKE` |
| `{{CONTRACT}}` | full 0x address | `0x6360…942bd` (full) |
| `{{CONTRACT_SHORT}}` | shortened address | `0x6360…942bd` |
| `{{DESCRIPTION}}` | creator description (or a generic line) | |
| `{{TAGLINE}}` | short hook (description or generic) | |
| `{{CHAIN}}` | chain name | `Robinhood Chain` |
| `{{LOGO_URL}}` | pfp URL (or a generated monogram) | use as `src` |
| `{{BUY_URL}}` | pad buy link for this coin | |
| `{{HOME_URL}}` | pad home (`https://robinlab.io`) | brand link |
| `{{CREATE_URL}}` | pad "launch a coin" link | |
| `{{SITE_HOST}}` | this site's host | `broke.robinlabs.fun` |
| `{{TELEGRAM_URL}}` `{{TWITTER_URL}}` `{{WEBSITE_URL}}` | social links (already safe) | wrap in IF blocks |
| `{{MCAP}}` `{{MCAP_UNIT}}` | market cap + unit | `7.20` `ETH` |
| `{{VOLUME}}` `{{VOL_UNIT}}` | all-time volume + unit | `15.2` `ETH` |
| `{{TRADES}}` | trade count | `9,306` |
| `{{HOLDERS}}` | approx holders | `210` |
| `{{PRICE}}` | last price (ETH) | |
| `{{GRAD_PCT}}` | curve progress 0–100 (int) | `61` |
| `{{GRAD_INSET}}` | `100 - GRAD_PCT` (for a right-inset fill) | `39` |
| `{{STATUS}}` | `Live` or `Graduated` | |

## The one rule that matters: coin identity vs. Robin Labs brand

The flagship $ROBIN site is confusing because the coin is *named after* the
platform. Generalise like this:

**Replace with tokens (this coin's identity / data / links):**
- The page subject: hero title, coin-card name, "about this coin" heading, the
  contract label, the footer coin handle → `{{NAME}}` / `{{NAME_UPPER}}`.
- The ticker `$ROBIN` anywhere → `{{TICKER}}`.
- The address `0x6696fe29288b586017e6f264c0091dba6c5ebeaf` (and short forms, and
  the copy-button JS `var addr`) → `{{CONTRACT}}`.
- Buy link `token.html?c=0x6696…` → `{{BUY_URL}}`; label "Buy $ROBIN" → "Buy {{TICKER}}".
- The embedded coin logo (`data:image/webp;base64,…`) → `{{LOGO_URL}}`; alt → `{{NAME}} logo`.
- Live numbers — market cap, volume, trades, curve/graduation % (and the CSS that
  hard-codes the bar width like `width:61%` / `inset:0 39% 0 0`) → `{{MCAP}}`,
  `{{VOLUME}}`, `{{TRADES}}`, `{{GRAD_PCT}}`, `{{GRAD_INSET}}`.
- The $ROBIN-specific hook / about copy → `{{TAGLINE}}` and `{{DESCRIPTION}}`.
- Social links → `{{TELEGRAM_URL}}` / `{{TWITTER_URL}}` / `{{WEBSITE_URL}}`, each
  wrapped in its `<!--IF:x-->` block so it disappears when unset.

**Keep literal (the Robin Labs launchpad brand — true for every coin):**
- The top-nav wordmark "ROBIN LABS" and the Robin Labs shield SVG.
- "Powered by Robin Labs", the footer brand, `robinlab.io` links, "Launch your own".
- The mechanics: "fair launch", "no presale / no team allocation", "permanent
  Uniswap v3 floor", "the creator earns 0.5 ETH at graduation", the trust strip.
  These describe how *every* Robin Labs coin works — leave them.

If a hero title is split into two differently-styled words (e.g.
`ROBIN` / `LABS`), collapse it to a single `{{NAME_UPPER}}` on the primary
styled element so any name renders.

Do **not** escape values yourself and do **not** change layout, CSS, fonts, or
the embedded `@font-face`. Only swap the touchpoints above. The file must remain
a valid standalone HTML document.
