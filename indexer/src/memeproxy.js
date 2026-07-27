// ─────────────────────────────────────────────────────────────────────────────
// Photo-to-meme proxy — turn a snapshot into a coin's meme character, server-side.
//
// The browser NEVER sees the image-model API key or the provider host. It POSTs a photo to
// our own /api/meme; this module normalizes the image, injects the SECRET key, calls the
// provider's image-edit endpoint, and returns the generated meme as a data URL the create
// page drops straight into the coin's pfp. OFF unless MEME_API_KEY is set. Provider-agnostic:
// defaults to OpenAI's /images/edits (gpt-image-1) but any compatible {base, model} works.
//
// IO (rate-limit, body read, CORS/send) lives in api.js; this stays focused on
// normalize → call → return so it's easy to reason about and swap providers.
// ─────────────────────────────────────────────────────────────────────────────
import { CFG } from "./config.js";

let _sharp = null;
async function sharp() {
  if (_sharp) return _sharp;
  _sharp = (await import("sharp")).default;
  return _sharp;
}

export function enabled() { return !!CFG.memeApiKey; }

// A short, fixed style brief. An optional user `style` is appended but never replaces the
// safety/branding intent (a clean, recognizable mascot that works as a tiny round avatar).
function buildPrompt(style) {
  const base =
    "Turn the subject of this photo into a clean, original cartoon meme mascot character for a " +
    "crypto memecoin avatar. Bold flat colors, thick outlines, expressive and funny, centered, " +
    "simple background, high contrast so it reads clearly as a small round profile picture. " +
    "Keep it recognizable but stylized; do not add text or watermarks.";
  const extra = String(style || "").trim().slice(0, 200);
  return extra ? `${base} Style direction: ${extra}` : base;
}

// Normalize any uploaded image to a square PNG the edit endpoint accepts (<4MB, sane dims).
// EXIF orientation is applied; the image is cover-fit to a square so faces stay centered.
async function toPngSquare(buf, dim = 1024) {
  const S = await sharp();
  return S(buf, { failOn: "none", limitInputPixels: 40_000_000 })
    .rotate()
    .resize(dim, dim, { fit: "cover" })
    .png()
    .toBuffer();
}

// Generate a meme from an uploaded image. Returns { dataUrl } or throws a friendly Error.
// `imageBuf` is the raw uploaded bytes; `style` is an optional user direction string.
export async function makeMeme({ imageBuf, style, timeout = 60000 }) {
  if (!enabled()) throw new Error("meme generator not configured");
  if (!imageBuf || !imageBuf.length) throw new Error("no image");
  if (imageBuf.length > CFG.memeMaxUploadBytes) {
    throw new Error(`image too large (max ${Math.floor(CFG.memeMaxUploadBytes / (1024 * 1024))}MB)`);
  }

  let png;
  try { png = await toPngSquare(imageBuf); }
  catch { throw new Error("could not read that image, try another photo"); }

  // Multipart form for the provider's image-edit endpoint (OpenAI-compatible shape).
  const form = new FormData();
  form.append("model", CFG.memeModel);
  form.append("prompt", buildPrompt(style));
  form.append("size", CFG.memeSize);
  form.append("quality", CFG.memeQuality);
  form.append("n", "1");
  form.append("image", new Blob([png], { type: "image/png" }), "photo.png");

  let r;
  try {
    r = await fetch(`${CFG.memeApiBase}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${CFG.memeApiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new Error("meme service is busy, try again in a moment"); }

  const j = await r.json().catch(() => null);
  if (!r.ok || !j) {
    const msg = (j && j.error && (j.error.message || j.error)) || `provider error (HTTP ${r ? r.status : "?"})`;
    // Don't leak provider internals to the client; log-worthy detail stays server-side.
    throw new Error(typeof msg === "string" && msg.length < 160 ? msg : "meme generation failed, try again");
  }
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error("meme generation returned nothing, try again");
  return { dataUrl: `data:image/png;base64,${b64}` };
}
