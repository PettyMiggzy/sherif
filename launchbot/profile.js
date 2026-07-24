// ─────────────────────────────────────────────────────────────────────────────
// Coin profile (pfp) upload
//
// The indexer accepts a creator-signed profile: the coin's dev signs a message
// binding the token + every field, and the server verifies the signer IS the dev
// before storing the image. Because the bot holds the dev's (custodial) key, it
// can sign the exact same message the website does.
//
// The signed message MUST byte-match indexer/src/api.js `profileMessage()` and
// pad/assets/wallet.js — do not reformat the canon JSON below.
// ─────────────────────────────────────────────────────────────────────────────
import { ethers } from 'ethers';
import { CFG } from './config.js';

/** Exact message the coin's dev signs (byte-match with the indexer + frontend). */
export function profileMessage(token, p) {
  const canon = JSON.stringify({
    description: p.description || '',
    telegram: p.telegram || '',
    twitter: p.twitter || '',
    website: p.website || '',
    pfp: p.pfp || '',
    banner: p.banner || '',
    ts: p.ts,
  });
  return `Robin Labs — set coin profile\ntoken: ${token.toLowerCase()}\nts: ${p.ts}\ndigest: ${ethers.id(canon)}`;
}

/**
 * Sign & upload a coin profile. `pfpDataUrl` is a base64 data: URL (the server
 * downscales any format, incl. HEIC, to a small webp). Returns the server JSON.
 * Only the dev's signature is accepted, so `signer` must be the coin's creator.
 */
export async function setProfile(signer, token, { pfpDataUrl = '', description = '', telegram = '', twitter = '', website = '' } = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = { description, telegram, twitter, website, pfp: pfpDataUrl, banner: '', ts };
  const signature = await signer.signMessage(profileMessage(token, payload));
  const r = await fetch(`${CFG.apiBase}/api/coin/${token.toLowerCase()}/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, signature }),
    signal: AbortSignal.timeout(20000), // never let a slow indexer hang the launch flow
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(body.error || `profile upload ${r.status}`);
  return body;
}
