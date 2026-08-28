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
//   • The model is chosen server-side from config, never from the request body. Venice's
//     catalogue runs from $0.01 to $0.29 an image; letting the client name the model lets the
//     client pick our bill, and the adult-tuned models are in that same list.
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

/// Generate artwork from a description. Returns { dataUrl, bytes } or throws a friendly Error.
export async function makeArt({ prompt, timeout = 90000 }) {
  if (!enabled()) throw new Error("art generator not configured");
  const want = String(prompt || "").trim();
  if (want.length < 3) throw new Error("describe what you want, in a few words at least");

  let r;
  try {
    r = await fetch(`${CFG.veniceApiBase}/image/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${CFG.veniceApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: CFG.veniceModel,
        prompt: buildPrompt(want),
        width: 1024,
        height: 1024,
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

  let out;
  try { out = await shrink(Buffer.from(b64, "base64")); }
  catch { throw new Error("art generation returned something unreadable, try again"); }

  return { dataUrl: `data:image/webp;base64,${out.toString("base64")}`, bytes: out.length };
}
