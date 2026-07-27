// Social share cards: the PNG renders to a valid image and the HTML carries the
// per-coin og:/twitter: tags + the human redirect. These are what make a shared coin
// link unfurl as its own card instead of one generic site image.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderCard, coinOgHtml, OG } from "../src/og.js";

const COIN = {
  token: "0x1111111111111111111111111111111111111111",
  name: "Robin the Fox", symbol: "ROBIN",
  graduated: false, progress: 0.62, mcapEth: 14.3, vol24hEth: 3.85, trades24h: 212,
};

test("renderCard returns a valid PNG at card dimensions", async () => {
  const buf = await renderCard(COIN, null);
  assert.ok(buf.length > 1000, "png has bytes");
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, OG.CARD_W);
  assert.equal(meta.height, OG.CARD_H);
});

test("renderCard composites a pfp without throwing, still a valid PNG", async () => {
  const pfp = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#e0631f" } }).png().toBuffer();
  const buf = await renderCard(COIN, { blob: pfp, mime: "image/png" });
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, OG.CARD_W);
});

test("renderCard survives a corrupt pfp (falls back to the text card)", async () => {
  const buf = await renderCard(COIN, { blob: Buffer.from("not an image"), mime: "image/png" });
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, "png"); // did not throw; text card still produced
});

test("coinOgHtml carries this coin's og/twitter tags and the redirect", () => {
  const html = coinOgHtml(COIN, "https://api.robinlab.io/og/" + COIN.token + ".png", "https://robinlab.io");
  assert.match(html, /<title>Robin the Fox \(\$ROBIN\) on Robin Labs<\/title>/);
  assert.match(html, /property="og:image" content="https:\/\/api\.robinlab\.io\/og\/0x1111/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /https:\/\/robinlab\.io\/token\.html\?c=0x1111/); // human redirect target
  assert.match(html, /http-equiv="refresh"/);
});

test("coinOgHtml escapes a coin name so it can't inject markup", () => {
  const evil = { ...COIN, name: '<img src=x onerror=alert(1)>', symbol: "X" };
  const html = coinOgHtml(evil, "https://api.robinlab.io/og/x.png", "https://robinlab.io");
  assert.ok(!html.includes("<img src=x"), "raw tag must not appear");
  assert.match(html, /&lt;img src=x/);
});
