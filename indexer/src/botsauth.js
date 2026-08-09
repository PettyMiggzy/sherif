// Who is allowed to drive the bots from the website.
//
// Admin is proved by SIGNATURE, not by a password or a bearer token. The
// platform wallet already exists, it is already the thing that owns the pad,
// and a signature cannot be leaked by a log line, a screenshot, a browser
// extension or a transcript the way a token can.
//
// Follows the pattern api.js already uses for coin profiles and websites --
// build a human-readable message, ethers.verifyMessage, compare the recovered
// address -- with two additions those flows do not need and this one does.
//
// ---- 1. a nonce, because this is a session, not an edit --------------------
//
// The profile/site flows sign the CONTENT being written, so a replayed
// signature just rewrites the same profile with the same values. An admin
// login signs nothing but "let me in", so without a server-issued nonce a
// captured signature is a permanent key to the control panel. Every challenge
// is single-use and expires.
//
// ---- 2. bound to this site, because the signer is a treasury --------------
//
// The wallet being asked to sign here holds real money and owns FeeConfig. So
// the message names the exact origin it is for: a signature phished on another
// domain will not verify here, and an admin who reads the prompt can see which
// site is asking. This is also why the message is plain text and never a typed
// structure the wallet might render as a transaction.
import { ethers } from "ethers";
import crypto from "node:crypto";

// Short, because a login is a deliberate act and a stale challenge lying
// around is a window someone else can use.
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// What the wallet is asked to sign. Deliberately readable in a wallet popup:
// an admin who does not recognise the origin should be able to tell at a
// glance and refuse.
export function adminMessage({ origin, nonce, issuedAt }) {
  return [
    "Robin Labs - bot dashboard sign-in",
    `site: ${origin}`,
    `nonce: ${nonce}`,
    `issued: ${new Date(issuedAt).toISOString()}`,
    "",
    "Signing this proves you control the platform wallet.",
    "It does not move funds and is not a transaction.",
  ].join("\n");
}

// Issued and held by the server. A Map rather than a store, because these live
// for five minutes and nothing needs them after a restart.
export function createChallengeStore({ now = () => Date.now(), ttlMs = CHALLENGE_TTL_MS } = {}) {
  const open = new Map(); // nonce -> { issuedAt, origin }

  const sweep = () => {
    const t = now();
    for (const [k, v] of open) if (t - v.issuedAt > ttlMs) open.delete(k);
  };

  return {
    issue(origin) {
      sweep();
      const nonce = crypto.randomBytes(16).toString("hex");
      const issuedAt = now();
      open.set(nonce, { issuedAt, origin });
      return { nonce, issuedAt, message: adminMessage({ origin, nonce, issuedAt }) };
    },

    // Returns { ok, address } or { ok: false, reason }.
    //
    // The challenge is consumed whether or not the signature verifies. A nonce
    // that survives a failed attempt is a nonce an attacker can keep trying
    // signatures against.
    verify({ nonce, signature, origin, admins }) {
      sweep();
      const held = open.get(nonce);
      open.delete(nonce);

      if (!held) return { ok: false, reason: "unknown or expired challenge" };
      if (held.origin !== origin) return { ok: false, reason: "challenge was issued for another site" };
      if (now() - held.issuedAt > ttlMs) return { ok: false, reason: "challenge expired" };

      let signer;
      try {
        signer = ethers.verifyMessage(
          adminMessage({ origin: held.origin, nonce, issuedAt: held.issuedAt }),
          String(signature || "")
        );
      } catch {
        return { ok: false, reason: "bad signature" };
      }

      // Addresses are compared lowercased. EIP-55 checksums differ only in
      // case, and a case-sensitive compare here would reject the real admin
      // depending on which wallet formatted the string.
      const who = signer.toLowerCase();
      const allowed = (admins || []).map((a) => String(a).toLowerCase()).filter(Boolean);
      if (!allowed.includes(who)) return { ok: false, reason: "not an admin address" };

      return { ok: true, address: who };
    },

    get size() { return open.size; },
  };
}

// Admin addresses, from the environment.
//
// Defaults to nothing rather than to the platform wallet: an admin surface
// that turns itself on because a variable is unset is the one that gets found.
// Set BOTS_ADMINS to the platform wallet -- or, better, to a separate key you
// are willing to connect to a website, since the platform wallet also owns
// FeeConfig and can re-cut every launch's fee split.
export function adminsFromEnv(env = process.env) {
  return String(env.BOTS_ADMINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}
