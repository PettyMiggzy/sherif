# Robin Labs mobile apps: build + submission guide

This is the whole job of shipping Robin Labs to the Google Play Store and the Apple App
Store, with an honest readiness audit and honest timelines. Read the timelines section
before you get excited: neither store is instant.

## What is already done (in this repo)

The website at robinlab.io is now a valid, installable PWA, which is the base that gets
packaged into both store apps. No separate app codebase to maintain; the app IS the site.

- Web manifest with proper name, icons (192, 512, and a padded maskable), theme, and app shortcuts: `pad/site.webmanifest`
- Service worker (installable + offline page, network-first so the dApp is never stale): `pad/sw.js`, registered from `pad/assets/wallet.js`
- Offline fallback page: `pad/offline.html`
- App icons: `pad/assets/icon-192.png`, `pad/assets/icon-maskable-512.png`, `pad/assets/favicon-512.png`
- Privacy policy (both stores REQUIRE a hosted one): https://robinlab.io/privacy.html

You cannot finish the builds on a Linux server. iOS builds require a Mac with Xcode.
Android needs your signing key. So the steps below run on your machine when you are home.

## Fastest path: PWABuilder (does BOTH stores)

PWABuilder turns the live PWA into a Play Store package and an iOS Xcode project.

1. Deploy the current branch so robinlab.io serves the new manifest + `sw.js` (Vercel auto-deploys). Confirm https://robinlab.io/sw.js and https://robinlab.io/site.webmanifest load.
2. Go to https://www.pwabuilder.com and enter `https://robinlab.io`. It scores the PWA and lets you package.
3. **Android package:** click Package For Stores -> Android -> Google Play. It generates a signed `.aab` (or you supply your own signing key). Download it. This is what you upload to the Play Console.
   - It also gives you an `assetlinks.json` containing your app's SHA-256 signing fingerprint. That file must be served at `https://robinlab.io/.well-known/assetlinks.json` (add it to `pad/.well-known/`) so Android verifies the app owns the domain and hides the browser address bar. Without it the app shows a URL bar and looks unfinished.
4. **iOS package:** click Package For Stores -> iOS. It generates an Xcode project. You open it on a Mac in Xcode, set your bundle id and Apple team, archive, and upload to App Store Connect.

## Android, the do-it-yourself alternative: Bubblewrap

If you prefer the command line to PWABuilder:

```
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://robinlab.io/site.webmanifest
bubblewrap build           # produces app-release-signed.aab + the assetlinks fingerprint
```

Then serve the printed `assetlinks.json` at `pad/.well-known/assetlinks.json` and upload the `.aab` to the Play Console. Bubblewrap needs a JDK and the Android SDK installed.

## Compliance / readiness audit (do these or you get rejected)

- [ ] **Privacy policy URL** — done: https://robinlab.io/privacy.html. Paste it into both stores' listing fields.
- [ ] **Age rating** — set 17+ (Apple) / Mature (Google). This is a crypto/finance app; do not mark it for kids.
- [ ] **Google Play Data safety form** — declare what you process. We do not sell data and do not collect accounts; you still must fill the form (say: no personal data collected, standard technical data for functionality).
- [ ] **Digital Asset Links** — serve `assetlinks.json` at `/.well-known/` (see above) so the Android app verifies the domain.
- [ ] **Store listing assets** — you need an app icon (have it), a feature graphic (1024x500, Google), and at least a few phone screenshots. Take these from the live app.
- [ ] **Account type check** — see the Google timeline note below; a personal account has a testing hurdle a business/organization account may not.

### The Apple-specific risk, and how to clear it

Apple approves crypto **wallets and trading** apps (MetaMask, Uniswap Wallet, Coinbase Wallet are all live). What triggers rejection for a launchpad is **letting users create/mint tokens** in-app, which Apple reads as facilitating an unregulated financial product.

Mitigation for the iOS build:
- Ship iOS as **browse + trade + portfolio**. That is a wallet/trading app Apple is used to approving.
- Make the **Launch** flow open in the external browser on iOS rather than mint in-app (a small conditional: on iOS, the Launch button links out to robinlab.io/create). Android keeps full in-app launch.
- Lead the App Review notes with "self-custody, non-custodial, users sign their own transactions, we never hold funds," and link the privacy policy.

Do not hide the crypto nature; that gets you banned. Present it as a self-custody trading app.

## Honest timelines (read this)

**Google Play:** the catch is not review speed, it is the account rule. Since 2023, brand-new
**personal** developer accounts must run a **closed test with at least 20 testers for 14 continuous
days** before they can promote an app to production. So from a cold personal account, plan on
**~2 to 3 weeks minimum** before the app is public, plus review (a few hours to ~7 days).
If your account is a registered **organization/business** account, this 20-tester rule may not
apply, check your Play Console. Review itself for a wrapped web app is usually fast.

**Apple App Store:** review is typically **24 to 48 hours** now. BUT a launchpad app has real
rejection risk on the token-creation feature, so budget for **1 to 2 weeks** with one or two
rounds of back-and-forth, and go in with the trade-only-on-iOS approach above. Once approved,
updates are fast.

**Bottom line:** Android is the cheaper, more likely-to-clear path but has the 14-day tester
gate on a new personal account. Apple is faster to review but more likely to bounce. Neither is
"submit today, live tomorrow." Start the Google closed test early since its clock is the long pole.

## Recommended order

1. Deploy so the live site serves the new PWA files (already committed).
2. Run PWABuilder -> Android, upload the `.aab`, add `assetlinks.json`, and immediately start the Google 20-tester closed test (its 14-day clock is the bottleneck).
3. While that clock runs, do the iOS package on a Mac with the trade-only Launch behavior, and submit to Apple.
