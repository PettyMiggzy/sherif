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

/// The look. A style is a whole BRIEF, not a phrase appended to one — asking the sticker brief for
/// "hand drawn" fights itself, because that brief demands flat fills and clean thick outlines, which
/// is precisely the machine-made look somebody asking for hand-drawn is trying to escape.
///
/// These four were sampled before shipping and two more were thrown away: "crayon" and "woodcut"
/// briefs were simply ignored by the model, which returned ordinary comic art both times. A style
/// nobody can tell apart from the default is worse than no style, so only what visibly worked is here.
///
/// Each carries its own exclusions as well. `ink` has to forbid "vector, clean lines, symmetrical",
/// or the model tidies the wobble straight back out.
const STYLES = {
  sticker: {
    label: "Sticker",
    brief:
      "A clean, original mascot illustration for a crypto memecoin avatar. Bold flat colors, " +
      "thick black outlines, expressive and funny. The subject is CENTERED and fills most of " +
      "the frame, on a simple flat background, with high contrast so it still reads clearly " +
      "shrunk to a small round profile picture.",
    negative: "photorealistic, photograph, 3d render, painterly, oil painting, muted colors",
  },
  ink: {
    label: "Hand-drawn",
    // NO PHYSICAL OBJECTS IN THIS BRIEF. An earlier version said "in a sketchbook ... on off-white
    // paper", and the model obliged literally: it drew a photograph of an open notebook lying on a
    // desk next to a pen, with the character small in the middle. Naming the surface invites a
    // SCENE. The look has to be described as qualities of the drawing itself, and the objects that
    // would imply a scene are pushed into the negatives.
    brief:
      "Hand-drawn ink and marker illustration. Visible pen strokes, slightly uneven wobbling " +
      "linework, cross-hatching for shadow, small imperfections, loose colour washes that spill " +
      "past the lines. Drawn by a person, not printed. The subject FILLS THE FRAME edge to edge " +
      "and is centered, on a plain flat off-white background and nothing else.",
    negative: "vector, clean lines, symmetrical, perfect, digital, flat fill, glossy, airbrushed, " +
      "sketchbook, notebook, book, page, desk, table, pen, pencil, hand, photograph of paper, " +
      "mockup, product photo, still life, scene, background objects",
  },
  paint: {
    label: "Painted",
    brief:
      "Loose ink and watercolour painting on paper. Wet bleeding washes, streaky uneven colour where " +
      "the brush overlapped itself, visible stroke ends, pigment pooling at the edges, a few stray " +
      "splatters. The subject is CENTERED and fills most of the frame on plain paper.",
    negative: "vector, gradient, glossy, airbrush, symmetrical, perfect lines, digital, flat fill",
  },
};

export function styles() {
  return Object.entries(STYLES).map(([k, v]) => ({ style: k, label: v.label }));
}

/// What the pad actually sends, regardless of what the user typed. `extra` is the user's own
/// description, appended and clipped — Venice's smallest model caps the prompt at 1500 chars and
/// rejects the request outright above it, so the clip is correctness, not tidiness.
function buildPrompt(style, extra) {
  const st = STYLES[style] || STYLES.sticker;
  const base = `${st.brief} No text, no lettering, no watermarks, no borders.`;
  const want = String(extra || "").trim().slice(0, 600);
  return want ? `${base} The subject: ${want}` : base;
}

/// What the model must NOT draw.
///
/// A positive instruction ("no text, no watermarks") is weak — the model sees the words TEXT and
/// WATERMARK and happily draws them. Measured on the cheap tier: one sample in four came back with
/// garbled lettering stamped in a corner, despite hide_watermark being on and the prompt asking for
/// none. A negative prompt is the channel these models actually respect for exclusions.
const NEGATIVE_BASE =
  "text, letters, words, lettering, typography, signature, watermark, logo, caption, subtitles, " +
  "frame, border, blurry, low quality, deformed, extra limbs, cropped, out of frame";

function buildNegative(style) {
  const st = STYLES[style] || STYLES.sticker;
  return `${NEGATIVE_BASE}, ${st.negative}`;
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
export async function makeArt({ prompt, tier = "medium", style = "sticker", timeout = 180000 }) {
  if (!enabled()) throw new Error("art generator not configured");
  const want = String(prompt || "").trim();
  if (want.length < 3) throw new Error("describe what you want, in a few words at least");
  const t = TIERS[String(tier).toLowerCase()];
  if (!t) throw new Error("pick a quality level");
  const look = STYLES[String(style).toLowerCase()] ? String(style).toLowerCase() : "sticker";
  const model = t.model();

  let r;
  try {
    r = await fetch(`${CFG.veniceApiBase}/image/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${CFG.veniceApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildPrompt(look, want),
        negative_prompt: buildNegative(look),
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
  try {
    out = await shrink(raw);
  } catch (e) {
    // The friendly message stays, but the real cause is logged: this catch once swallowed a
    // MISSING FUNCTION and reported it as a bad image, which is a bug that looks like weather.
    console.error("[art] post-processing failed:", e?.message || e);
    throw new Error("art generation returned something unreadable, try again");
  }

  return { dataUrl: `data:image/webp;base64,${out.toString("base64")}`, bytes: out.length };
}
