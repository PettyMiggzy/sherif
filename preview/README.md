# Robin Labs — internal site preview

`robin-labs-site-preview.html` is a **self-contained snapshot of the whole front end** (home, launch,
coin page, Rewards, stats, docs, promo) bundled into one file — all CSS, JS, and images inlined, no
server or wallet needed. Double-click it, or open it in any browser, and click through the full site.

- Runs in **preview mode** with sample data (the 👁 badge). Buttons like Connect / Buy / Launch / Claim
  show a "live on the real site" note instead of touching the chain.
- **Not part of the deployed site** — it lives here, outside `pad/`, so it's never served publicly.
  It's here purely so the team can review the current build from the repo.
- Regenerate it from the live `pad/` source with the build script in the session scratchpad
  (`build-full-site.mjs`) whenever the site changes.

Live shareable copy of this same snapshot: publish via the session's Artifact link.
