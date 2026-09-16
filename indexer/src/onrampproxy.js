// ─────────────────────────────────────────────────────────────────────────────
// Arc Onramp proxy — the server-side half of "buy with a card." Mints a short-lived onramp
// session via Circle's @circle-fin/app-kit SDK. The API key never reaches the browser (the SDK
// itself calls this out as a hard requirement); the browser only ever sees the resulting
// sessionToken/widgetUrl, which is single-purpose and expires in ~30 minutes.
//
// This does NOT buy a pad token — it only gets USDC into the user's Arc wallet. The auto-swap
// from that USDC into a chosen pad token is a separate step the frontend triggers once the
// widget reports DEPOSIT_SETTLED (see pad/js/onramp-widget.js).
// ─────────────────────────────────────────────────────────────────────────────
import { createAppServerKit } from "@circle-fin/app-kit/server";
import { CFG } from "./config.js";

let _kit = null;
function kit() {
  if (_kit) return _kit;
  _kit = createAppServerKit({
    onramp: {
      apiKey: CFG.onrampApiKey,
      ...(CFG.onrampReferrerDomain ? { referrerDomain: CFG.onrampReferrerDomain } : {}),
    },
  });
  return _kit;
}

// body: { destinationAddress: "0x…", appUserId?: string }. appUserId defaults to the destination
// address itself — we have no user-account system, so the wallet address IS the identity.
export async function createSession(body) {
  const destinationAddress = String(body?.destinationAddress || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
    return { status: 400, json: { error: "destinationAddress must be a 0x… address" } };
  }
  try {
    const session = await kit().onramp.createSession({
      appUserId: body?.appUserId ? String(body.appUserId).slice(0, 128) : destinationAddress,
      destinationAddress,
      destinationChain: "Arc",
    });
    // Only forward the fields the client actually needs — never the raw upstream response.
    return {
      status: 200,
      json: {
        sessionToken: session.sessionToken,
        widgetUrl: session.widgetUrl,
        expiresAt: session.expiresAt,
        destinationWallet: session.destinationWallet,
      },
    };
  } catch (e) {
    return { status: 502, json: { error: "onramp upstream error", detail: String(e?.message || e) } };
  }
}
