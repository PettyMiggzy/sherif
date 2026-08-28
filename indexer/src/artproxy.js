// ─────────────────────────────────────────────────────────────────────────────
// Text-to-art proxy — generate a coin's artwork from a written description.
//
// The browser NEVER sees the Venice key or the provider host. It POSTs a prompt to our own
// /api/art; this module builds the real prompt, injects the SECRET key, calls Venice, shrinks
// the result, and returns a data URL the create page drops straight into the coin's pfp.
// OFF unless VENICE_API_KEY is set.
//
// Sibling of memeproxy.js, which edits an uploaded PHOTO. This one starts from nothing but
// words. They are deliberately separate endpoints with separate spend caps: a text endpoint
// needs no upload path and has a very different abuse profile.
//
// THREE THINGS HERE ARE NOT CONFIGURABLE, ON PURPOSE:
//
//   • `safe_mode` is forced on. This endpoint is reachable by anyone who can load the create
//     page, and Venice hosts uncensored models — a public generator that will draw anything
//     is a liability with our name on the output. It is not a request field, so no client can
//     turn it off by sending one.
//   • The model is chosen server-side from config, never from the request body. The client picks a
//     TIER — standard / medium / high — and the tier maps to a model here. The provider and the
//     model name are never sent to the browser and never appear in a response: they are a supplier
//     relationship and a cost, not a product feature, and publishing them invites someone to go buy
//     the same image direct for a third of the price. Venice's catalogue also runs $0.01 to $0.29
//     an image and includes adult-tuned models, so a client-named model would be a client-named
//     bill.
//   • The user's words are APPENDED to a fixed brief, never substituted for it, and truncated.
//     The brief is what keeps the output usable as a tiny round avatar.
//
// IO (rate limits, body read, CORS) lives in api.js; this stays prompt → call → shrink.
// ─────────────────────────────────────────────────────────────────────────────
import { CFG } from "./config.js";

let _sharp = null;
async function sharp() {
  if (_sharp) return _sharp;
  _sharp = (await import("sharp")).default;
  return _sharp;
}

export function enabled() { return !!CFG.veniceApiKey; }

/// What the pad tells Venice, regardless of what the user typed. `extra` is the user's own
/// description, appended and clipped — Venice's smallest model caps the prompt at 1500 chars
/// and rejects the request outright above it, so the clip is correctness, not tidiness.
function buildPrompt(extra) {
  const base =
    "A clean, original mascot illustration for a crypto memecoin avatar. Bold flat colors, " +
    "thick black outlines, expressive and funny. The subject is CENTERED and fills most of " +
    "the frame, on a simple flat background, with high contrast so it still reads clearly " +
    "shrunk to a small round profile picture. No text, no lettering, no watermarks, no borders.";
  const want = String(extra || "").trim().slice(0, 600);
  return want ? `${base} The subject: ${want}` : base;
}

/// Venice returns a 1024px PNG — measured at 2.1MB, which is far too heavy for something that
/// renders as a 40px circle in a coin list and gets embedded in a profile payload. Shrink and
/// re-encode before it ever leaves this process.
async function shrink(pngBuf) {
  const S = await sharp();
  return S(pngBuf, { failOn: "none", limitInputPixels: 40_000_000 })
    .resize(CFG.veniceOutPx, CFG.veniceOutPx, { fit: "cover" })
    .webp({ quality: 88 })
    .toBuffer();
}

/// A generated image that came back as a single flat colour — usually pure black.
///
/// THIS IS NOT THEORETICAL. Measured on nano-banana-2-lite: one generation in three returned a
/// solid black 1024x1024 PNG, with HTTP 200, a valid image, and a full charge. Without this check
/// the pad would hand that to a creator as their coin's artwork AND burn one of their credits for
/// it. Standard deviation is the tell: real art is noisy, a flat fill has none.
async function isBlank(buf) {
  try {
    const S = await sharp();
    const st = await S(buf).stats();
    // Alpha is excluded — a fully opaque image has zero variance on that channel by definition and
    // would make every image look flat.
    const colour = st.channels.slice(0, 3);
    return colour.every((c) => c.stdev < 3);
  } catch {
    return false; // unreadable is a different failure; let the caller's decode path report it
  }
}

/// Which model serves which tier. NEVER sent to a client — see the header. Tunable by env so a bad
/// model can be swapped out during an incident without a deploy.
const TIERS = {
  standard: { model: () => CFG.veniceModelStandard, credits: () => CFG.veniceCreditsStandard },
  medium: { model: () => CFG.veniceModelMedium, credits: () => CFG.veniceCreditsMedium },
  high: { model: () => CFG.veniceModelHigh, credits: () => CFG.veniceCreditsHigh },
};

export function tiers() {
  return Object.keys(TIERS).map((k) => ({ tier: k, credits: TIERS[k].credits() }));
}
export function creditsFor(tier) {
  const t = TIERS[String(tier || "").toLowerCase()];
  return t ? t.credits() : null;
}

/// Generate artwork from a description. Returns { dataUrl, bytes } or throws a friendly Error.
export async function makeArt({ prompt, tier = "medium", timeout = 180000 }) {
  if (!enabled()) throw new Error("art generator not configured");
  const want = String(prompt || "").trim();
  if (want.length < 3) throw new Error("describe what you want, in a few words at least");
  const t = TIERS[String(tier).toLowerCase()];
  if (!t) throw new Error("pick a quality level");
  const model = t.model();

  let r;
  try {
    r = await fetch(`${CFG.veniceApiBase}/image/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${CFG.veniceApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildPrompt(want),
        // Both parameter styles are sent because the catalogue is not uniform: the SD-family models
        // take width/height, the newer ones take an aspect ratio and a resolution class. Each ignores
        // the pair it does not use, which is cheaper than keeping a per-model shape table in sync.
        width: 1024,
        height: 1024,
        aspect_ratio: "1:1",
        resolution: CFG.veniceResolution,
        steps: CFG.veniceSteps,
        format: "png",
        safe_mode: true,        // see the header — deliberately not a request field
        hide_watermark: true,
        return_binary: false,
        embed_exif_metadata: false,
      }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new Error("the art service is busy, try again in a moment"); }

  const j = await r.json().catch(() => null);
  if (!r.ok || !j) {
    // Never hand a provider's error text to the browser verbatim: Venice echoes request details
    // back on a 400, and the request contains the model and our parameters.
    const detail = j && (j.error || j.message);
    const msg = typeof detail === "string" && detail.length < 160 ? detail : null;
    throw new Error(msg || `art generation failed (HTTP ${r.status})`);
  }

  // Venice answers { id, images: ["<base64 png>"], request, timing }. Accept the OpenAI-compatible
  // shape too, so swapping VENICE_API_BASE for another provider does not need a code change.
  const b64 = (Array.isArray(j.images) && j.images[0])
    || (j.data && j.data[0] && j.data[0].b64_json)
    || null;
  if (!b64) throw new Error("art generation returned nothing, try again");

  const raw = Buffer.from(b64, "base64");
  // Checked BEFORE shrinking and before the caller charges anybody. A blank result is a failed
  // generation we were nonetheless billed for; the customer must not be billed for it as well.
  if (await isBlank(raw)) throw new Error("that one came out blank — try again, you were not charged");

  let out;
  try { out = await shrink(raw); }
  catch { throw new Error("art generation returned something unreadable, try again"); }

  return { dataUrl: `data:image/webp;base64,${out.toString("base64")}`, bytes: out.length };
}
