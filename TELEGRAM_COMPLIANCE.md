# Telegram Trading/Launch Bot — Compliance & Reference Brief

**For Claude Code / any dev working in this repo.** This file is the working
reference for keeping the Telegram bot (`launchbot/`) inside Telegram's platform
rules. It is written in our own words with **exact quotes** where the wording is
load-bearing. For legally binding text, read the live source pages — Telegram
amends them at its discretion.

> **Regulatory, licensing, KYC/AML and fund-custody-legality decisions are OUT OF
> SCOPE for code generation** and must be resolved by a human with fintech/
> securities counsel. Do not treat a scaffolded KYC flow, custody feature, or
> "compliance" toggle as making the operation legal — that is a legal question,
> not a code question. See §9.

---

## 0. Source documents (authoritative — always defer to the live pages)

- Bot Platform Developer Terms — https://telegram.org/tos/bot-developers
- Blockchain guidelines (permitted/prohibited examples) — https://core.telegram.org/bots/blockchain-guidelines
- General Telegram ToS — https://telegram.org/tos
- Privacy Policy — https://telegram.org/privacy  (see §6.3 "What Data Bots Receive")
- API Terms — https://core.telegram.org/api/terms
- Bot API technical docs — https://core.telegram.org/bots/api
- Monitor for changes: **@BotNews**

---

## 1. Crypto / blockchain — THE decisive rule (Bot Dev Terms §7 + blockchain guidelines)

This is the highest-risk area and the reason bots like this get pulled. The exact
scope, quoted verbatim:

- **§7 chapeau:** *"all **Mini Apps** which implement cryptocurrency functionality,
  either within the Mini App itself or within its connected bot, are required to
  be based exclusively on The Open Network (TON) blockchain."*
- **§7.1–7.4** each begin with *"Mini App(s)"* as the subject (issuing assets,
  connecting wallets, multichain wallets, promotion).
- **Blockchain guidelines, verbatim:** *"For clarity, these rules **only apply** to
  Mini Apps and their bots on the Telegram platform. Regular Telegram bots that
  **do not** have a Mini App component are exempt."*

### What this means for us (verified)
- **This bot is a plain command bot with NO Mini App / WebApp.** It therefore
  falls under the explicit exemption above — the TON-only requirement does **not**
  apply. This is the correct and current reading, confirmed on the guidelines page.
- **"Its connected bot" ≠ any bot.** That clause closes the loophole of moving
  crypto logic out of a Mini App into the bot *backing that Mini App*. With **no
  Mini App at all**, there is nothing for §7 to attach to.

### The ONE hard architectural constraint (do not cross)
- **NEVER add a Mini App / WebApp component** (`web_app` buttons, a menu-button web
  app, TON Connect, an in-Telegram trade/launch UI). The instant a Mini App exists,
  the whole bot's crypto functionality — Mini App *or connected bot* — is pulled
  into TON-only scope and is non-compliant on a non-TON chain (Robinhood Chain,
  id 4663). Keep the on-chain UI on the external website only, reached by a plain
  `url` button, never a `web_app` button.
- **§7.4 promotion (Mini-App-scoped, but stay clean anyway):** don't reward users
  for connecting non-TON wallets and don't build features whose purpose is
  promoting non-TON assets inside a Mini App. N/A while we have no Mini App.

### Prohibited examples that DO name non-TON chains (guidelines, verbatim)
- *"Tokens and NFTs on other blockchains like Ethereum, BNB, etc. are not permitted."* (Mini-App scope)
- *"Connecting an Ethereum wallet to sign a transaction within the app."* (Mini-App scope)
- *"Directing or linking users to external platforms or websites where cryptoassets not based on TON are promoted or utilized."* (Mini-App scope)

All of these are scoped to Mini Apps. They become our problem only if we ship a Mini App.

---

## 2. Payments (Bot Dev Terms §6)

- Physical goods → third-party providers; Telegram holds no funds (§6.1).
- **Digital goods/services → Telegram Stars only (§6.2).** Alternative in-Telegram
  payment rails for digital goods risk removal.
- **Our posture:** the bot takes **no Telegram-native payment at all.** All value
  moves **on-chain** in the user's own custodial wallet. Any optional bot fee
  (`LAUNCH_FEE_ETH`) is charged **on-chain in ETH**, never via Telegram. Keep it
  that way — do NOT wire in Stars/`sendInvoice` for launches.
- Implement **`/paysupport`** (§6.2.1). ✅ done (`bot.js`).
- Broadcasting >30 msg/sec needs Stars/thresholds (§6.2.5) — we're nowhere near it,
  and there is no broadcast feature.

---

## 3. Security & data (Bot Dev Terms §4; Privacy §6.3)

- **Encrypt user data at rest, key stored separately (§4.4a).** ✅ AES-256-GCM +
  scrypt; the encryption key is derived from `MASTER_SECRET` (env, off-repo), never
  stored beside the ciphertext. Keystore file `0600`, dir `0700`, durable fsync.
- **Honor deletion (§4.2).** ✅ `/forget` erases the user's record + session +
  cached key.
- **Breach notification per law (§4.4b).** ⚠️ operational: if `MASTER_SECRET`/store
  is compromised, notify affected users and rotate. Keep an admin alert path.
- **No scraping / dataset / ML-training on Telegram data (§4.3; API Terms §1.5).**
  ✅ we store only the DMing user's own id, wallet, launches.
- **Publish a privacy policy** registered via @BotFather (§4). ⚠️ set `TERMS_URL`
  and register the policy; the bot links it in `/start` and `/disclaimer`.
- **Protect credentials (§4.5).** ✅ token, `MASTER_SECRET`, `RPC_URL` live in
  `.env` (git-ignored), never logged.

### What the bot receives (Privacy §6.3) — request the minimum
Public account data, the messages the user sends the bot, IP only if they click a
bot-controlled link, group membership when added. We ignore all non-private chats,
so we never process group messages.

---

## 4. Code of conduct — hard prohibitions (Bot Dev Terms §5.2)

Forbidden: MLM/Ponzi; "social growth manipulation"; phishing / deceptive data
collection; **asking for a user's Telegram password or OTP**; misrepresenting an
illegal product as legally purchasable; **spam / unsolicited messages**;
impersonating Telegram; malware; hate speech/harassment.

**Our posture:**
- ✅ **Never** asks for Telegram password/OTP — and the disclaimer says so.
- ✅ **Opt-in only, no unsolicited DMs, no broadcast.** The bot replies only to
  users who DM it first and ignores group chats. The single outbound-to-non-sender
  path is the launch **announce** to ONE operator-owned channel (`ANNOUNCE_CHAT_ID`),
  throttled, only on a real launch — never a mass-DM.
- ✅ **No misrepresentation / no pump framing.** Launch copy is neutral; the
  disclaimer states plainly this is **not securities, not investment advice, no
  promise of profit**, and coins are experimental high-risk with no intrinsic value.
- ✅ **Content moderation** on user-supplied coin name/ticker (denylist for slurs +
  brand-impersonation), extendable via `BLOCKED_WORDS`.
- ✅ **Age/jurisdiction gate:** no wallet is created until the user taps "I agree"
  (18+, permitted jurisdiction, accepts risk). Consent is recorded.
- ✅ **Per-user rate limit** on `/launch` to prevent spam-minting.

---

## 5. Branding & interface (§8.1, §5.3, §5.2c)

- No "Telegram" in the bot name; no Telegram logos/marks; must not appear
  Telegram-affiliated. ✅
- UI must not fake system/Telegram notifications. ✅ plain messages + inline
  keyboards only.
- ⚠️ **Trademark caution (operational, for the human):** the project brand
  ("Robin Labs" / "Robinhood Chain") leans on a famous financial mark. If not
  affiliated with Robinhood Markets, this is an easy trademark/impersonation report
  vector (§5.2c). Consider neutral branding — a naming decision for the owner, not
  a code fix.

---

## 6. Liability, termination, platform risk (§3, §10, §12, §13)

- Platform is "as is"; Telegram is **not liable** for lost funds/data and can
  **suspend/terminate the bot AND the owning account at its sole discretion, with no
  notice, cause, or compensation** (§3, §10.1). Associated accounts can also be
  banned.
- Keep our **own source-of-truth persistence** (the encrypted keystore) — don't
  rely on any Telegram-side storage.
- **Secure the owning Telegram account with 2FA** — losing it can strand every bot.

---

## 7. Top real-world takedown triggers for a bot like this (ranked)

1. **Reported as a scam / rug-pull** (main ToS + §5.2d). Highest exposure; needs
   only user reports. Mitigations in code: neutral copy, securities disclaimer,
   content moderation, consent gate, "keep only what you'll use" custody nudge.
2. **Unlicensed financial service** (§9). Custody + trading with no KYC/AML/geofence.
   **Cannot be fixed in code — legal question (see §9 below).**
3. **Trademark / impersonation** via branding (§5.2c). Operational — rename decision.
4. **Adding a Mini App/WebApp → instant §7 violation.** Avoid entirely (see §1).
5. **Announce-feature spam** (§5.2b) if pointed at a non-owned chat or un-throttled.
   Mitigated: throttled, operator-owned channel, opt-out via blank env.

---

## 8. This bot's compliance checklist (keep true)

- [x] Command bot only — **no Mini App / WebApp / TON Connect**
- [x] No Telegram Stars / no Telegram-native payments; fee (if any) on-chain ETH
- [x] `/paysupport` implemented
- [x] Opt-in DMs only; ignores groups; no broadcast/mass-DM
- [x] Encrypt-at-rest (AES-256-GCM + scrypt), key from env, durable keystore
- [x] `/forget` erasure (record + session + cached key)
- [x] Neutral copy + "not securities/not advice" disclaimer
- [x] Age/jurisdiction consent gate before any wallet is created
- [x] Content moderation on coin name/ticker
- [x] Per-user launch rate-limit; announce throttled to one owned channel
- [ ] `TERMS_URL` set + privacy policy registered via @BotFather (operator step)
- [ ] Owning Telegram account has 2FA (operator step)

---

## 9. OUT OF SCOPE for code — resolve with a lawyer before public launch

A trading/launch bot's biggest legal exposure lives **outside** Telegram's terms,
and no amount of code makes it compliant:

- **Financial / securities / AML regulation.** Custodying user funds + executing
  trades can classify the operation as a **money transmitter, VASP, broker, exchange,
  or adviser**, triggering licensing + KYC/AML duties (e.g. FinCEN/MSB in the US,
  MiCA in the EU). Telegram §9 pushes 100% of this onto the operator.
- **Third-party venue/API terms** for any chain/RPC/exchange integrated.
- **Tax** on any income (§6.4).

These are flagged for the **human owner**, not for Claude Code to "solve" by
scaffolding features.
