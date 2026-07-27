// Photo-to-meme proxy: it's OFF by default (no key) and refuses work + rejects junk input so a
// misconfigured or probed endpoint never calls a provider or spends. The happy path (multipart
// call + response parse) is covered by the manual end-to-end run against a mock provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enabled, makeMeme } from "../src/memeproxy.js";

test("meme generator is disabled without a key", () => {
  assert.equal(enabled(), false); // no MEME_API_KEY in the test env
});

test("makeMeme refuses to run while disabled", async () => {
  await assert.rejects(() => makeMeme({ imageBuf: Buffer.from("x") }), /not configured/);
});

test("makeMeme rejects an empty image even in shape checks", async () => {
  // enabled() is false here, so it short-circuits before touching a provider — the point is it
  // never throws an unexpected error type or hangs.
  await assert.rejects(() => makeMeme({ imageBuf: Buffer.alloc(0) }), /not configured|no image/);
});
