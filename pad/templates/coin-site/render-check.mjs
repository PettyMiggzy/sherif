// Validates that every coin-site template is fully data-driven: renders each with
// a fake coin through the engine and asserts no flagship $ROBIN data leaks, no
// stray markers survive, real coin data lands, and values stay XSS-safe.
//
//   node pad/templates/coin-site/render-check.mjs
//
// Exits non-zero on any failure. Run in CI / before shipping a template change.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CoinSite = require(join(HERE, "..", "..", "assets", "coinsite.js"));

const FLAGSHIP_ADDR = "0x6696fe29288b586017e6f264c0091dba6c5ebeaf";
const TEMPLATES = readdirSync(HERE).filter((f) => /\.html$/.test(f) && f !== "index.html");

// A realistic non-flagship coin with socials, plus an adversarial one.
const coin = {
  token: "0x6360b2f602a71241b65e10665e962165f5e942bd", name: "Broke", symbol: "BROKE",
  graduated: false, progress: 0.42, mcapEth: 3.1, volAllEth: 8.4, tradesAll: 1234, holders: 210,
  lastPriceEth: 0.0000031, image: null, telegram: "brokecoin", twitter: "@brokecoin",
  website: "https://broke.example", description: "we are so broke it is a lifestyle",
};
const evil = {
  token: "0x000000000000000000000000000000000000dead",
  name: '<img src=x onerror=alert(1)>', symbol: '"><script>alert(1)</script>',
  graduated: true, progress: 1, description: "</p><script>alert(2)</script>",
  website: "javascript:alert(3)", telegram: "a\"onmouseover=\"alert(4)",
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };

for (const file of TEMPLATES) {
  const tpl = readFileSync(join(HERE, file), "utf8");

  // Template must actually be tokenized (not a leftover static $ROBIN page).
  ok(/\{\{[A-Z0-9_]+\}\}/.test(tpl), `${file}: contains {{TOKENS}} (was tokenized)`);
  ok(!tpl.includes(FLAGSHIP_ADDR), `${file}: no hardcoded flagship address in source`);
  ok(!tpl.includes("$ROBIN"), `${file}: no literal $ROBIN in source`);

  const out = CoinSite.render(tpl, coin, "broke");
  ok(!out.includes("{{"), `${file}: no leftover {{token}} after render`);
  ok(!/<!--\/?IF:/.test(out), `${file}: no leftover IF markers after render`);
  ok(!out.includes(FLAGSHIP_ADDR), `${file}: flagship address gone after render`);
  ok(!out.includes("$ROBIN"), `${file}: $ROBIN gone after render`);
  ok(out.includes("$BROKE"), `${file}: renders the coin ticker`);
  ok(out.includes(coin.token), `${file}: renders the coin contract`);
  // Robin Labs BRAND chrome should survive (it's true for every coin).
  ok(/robin\s*labs/i.test(out), `${file}: keeps Robin Labs brand chrome`);

  // XSS: adversarial values must not produce live script/handler injection.
  const eout = CoinSite.render(tpl, evil, "x");
  // The RAW payloads must never survive un-escaped; the same chars as inert escaped
  // text (&lt;img…&gt; inside an attribute or body) are harmless.
  ok(!eout.includes("<script>alert(1)</script>"), `${file}: raw script payload escaped`);
  ok(!eout.includes("<img src=x onerror=alert(1)>"), `${file}: raw onerror tag escaped`);
  ok(eout.includes("&lt;img src=x"), `${file}: adversarial name was html-escaped`);
  ok(!eout.includes("javascript:alert"), `${file}: javascript: url rejected`);
  ok(!eout.includes("{{"), `${file}: no leftover tokens with adversarial input`);
}

console.log(`\n${TEMPLATES.length} templates · ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
