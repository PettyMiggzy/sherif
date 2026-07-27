# Robin Labs on the Apple App Store: the approval playbook

Researched 2026. The short version: a non-custodial memecoin app CAN get approved. Two live
precedents prove it (Moonshot, id6503993131; pump.fun, id6717572591). The trick is framing the
app as a self-custody WALLET, not an exchange or a launchpad.

## The rule that governs us

- 3.1.5(i) Wallets: allowed if the developer is enrolled as an ORGANIZATION (not Individual).
- 3.1.5(iii) Exchanges: need licensing per region. AVOID this bucket.
- 3.1.5(iv) ICOs / token issuance: must come from licensed banks/securities firms. A startup
  cannot satisfy this, so any "launchpad / presale / raise funds" framing is an auto-reject.

The line Apple cares about: secondary-market SWAPPING of an existing token (allowed, wallet) vs
PRIMARY ISSUANCE / fundraising (not allowed unless you are a licensed institution). Keep all
issuance off the device.

## What the approved apps do (copy this)

- "Self-custodial wallet. You own your funds, we can never access, move, or freeze them."
- "A visual interface to decentralized exchanges." (NOT an exchange, NOT a counterparty, NO order book.)
- Disclaimers on-screen: not an exchange, no investment advice, memecoins are for entertainment,
  no intrinsic value, you may lose everything.
- Wallet infra via a known SDK (pump.fun uses Privy). Signals genuine non-custody.

## The build config for Robin Labs iOS

INCLUDE in-app: discover/browse/charts, self-custody wallet (Privy/Turnkey/Dynamic style, key
export, Face ID), spot swap against Robinhood Chain DEX (user signs every tx), portfolio/P&L,
on-screen disclaimers. Optional: a LICENSED third-party fiat on-ramp (MoonPay/Stripe/Coinbase),
where the provider is the regulated party, never us.

EXCLUDE from the binary: token creation/mint/launch (opens Safari to robinlab.io instead),
any presale/allocation/whitelist/raise, our own fiat on-ramp acting as money transmitter,
order book / limit-orders-as-exchange / perps / derivatives / CFDs, earn-crypto-for-tasks,
unlocking app features with crypto.

The 2025 Epic v. Apple ruling explicitly permits a "Create a coin on the web" button that opens
Safari, in the US. Just do not let the app become a thin shell of links (that trips 4.2); our
in-app swap + portfolio is real functionality, so we clear it.

## Store listing / metadata

- Developer account: ORGANIZATION (needs a free D-U-N-S number, can take a few days).
- Category: Entertainment (lower scrutiny, matches "memecoins are entertainment") or Finance.
  Recommend Entertainment for v1.
- Age rating: 18+.
- Keep these words OUT of name/subtitle/keywords/screenshots/description: launchpad, presale,
  ICO, IDO, raise, fundraise, invest, returns, guaranteed. Use: discover, trade, swap, track,
  self-custody wallet, visual interface to decentralized exchanges.
- Privacy policy: https://robinlab.io/privacy.html

## App Review notes (paste this into App Review Information)

Robin Labs is a non-custodial self-custody wallet and a visual interface to public decentralized
exchange (DEX) smart contracts on Robinhood Chain.

Custody: Users generate and hold their own private keys and can export them at any time. Robin
Labs never takes custody and cannot access, move, or freeze user funds. Every transaction is
signed by the user on-device.

Not an exchange: Robin Labs does not operate an order book, does not act as counterparty, does
not sell tokens from inventory, and holds no customer assets. All swaps are peer-to-protocol
interactions with public DEX contracts. This app is a wallet under Guideline 3.1.5(i), not an
exchange under 3.1.5(iii). We are enrolled as an Organization.

No primary issuance in-app: The app does not facilitate any ICO, presale, token launch, or
fundraising. Token creation is not available in the app; a link may open Safari to our website
(robinlab.io), which we own and operate, consistent with the guidelines permitting external
links in the United States.

No IAP-eligible content: The app does not sell digital goods or unlock features via
cryptocurrency.

Compliance: Trading is geofenced to exclude sanctioned and prohibited jurisdictions and any
region where we lack permissions. On-screen disclaimers state the app is not an exchange,
provides no investment advice, and that tokens are highly speculative with possible total loss.

Comparable approved apps using this same non-custodial DEX-interface model include Moonshot
(id6503993131) and pump.fun (id6717572591). Test wallet and walkthrough available on request.

## Honest odds

Roughly 70 to 85 percent eventual approval, but expect at least one rejection round and possibly
multi-week delays. Crypto review is discretionary: even Uniswap Wallet, a textbook non-custodial
swap wallet, was stalled for months with no stated reason. Submit as an Organization, keep the
marketed feature set squarely wallet + swap + portfolio, keep every launch/mint concept off the
device, ship the disclaimers on-screen, and calmly re-submit citing Moonshot + pump.fun if the
first reviewer balks.
