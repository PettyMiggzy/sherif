import { keccak256, sha256, toBytes, type Hex } from 'viem';

// Token-page metadata (description, split, links, image) is written only by
// the token's current creator — RobinRevenueSplitter.creator() on-chain — who
// signs exactly what is being saved. Shared by the create page (builds and
// signs) and /api/metadata (rebuilds and verifies), so both sides hash the
// same canonical bytes.

export const MAX_DESCRIPTION = 200;
export const MAX_LINK = 200;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // under Vercel's 4.5 MB function body limit
export const SIG_MAX_AGE_SEC = 600;

export type MetaSplit = { creator: number; buyback: number; dividends: number; liquidity: number };
export type MetaLinks = { x: string; website: string; telegram: string };
export type MetaContent = { description: string; split: MetaSplit; links: MetaLinks };

const LINK_HOSTS: Record<keyof MetaLinks, string[] | null> = {
  x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
  telegram: ['t.me', 'telegram.me'],
  website: null, // any https host
};

/** https-only, no embedded credentials, host allow-listed per field. '' means unset. */
export function normalizeLink(kind: keyof MetaLinks, raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  if (s.length > MAX_LINK) throw new Error(`The ${kind} link is over ${MAX_LINK} characters`);
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`The ${kind} link doesn't look like a web address`); }
  if (u.protocol !== 'https:') throw new Error(`Only https:// addresses work for the ${kind} link`);
  if (u.username || u.password) throw new Error(`The ${kind} link can't include a username or password`);
  const hosts = LINK_HOSTS[kind];
  if (hosts && !hosts.includes(u.hostname.toLowerCase())) throw new Error(`The ${kind} link has to point to ${hosts[0]}`);
  return u.toString();
}

/** Validates and canonicalizes; throws a user-facing message on bad input. */
export function normalizeContent(input: { description?: unknown; split?: unknown; links?: unknown }): MetaContent {
  const description = (typeof input.description === 'string' ? input.description : '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (description.length > MAX_DESCRIPTION) throw new Error(`The description can be at most ${MAX_DESCRIPTION} characters long`);

  const sp = (input.split ?? {}) as Record<string, unknown>;
  const split = {} as MetaSplit;
  for (const k of ['creator', 'buyback', 'dividends', 'liquidity'] as const) {
    const v = sp[k] ?? 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) throw new Error(`Share plan: ${k} needs a whole number from 0 to 100`);
    split[k] = v;
  }
  const total = split.creator + split.buyback + split.dividends + split.liquidity;
  if (total !== 100 && total !== 0) throw new Error('Share plan numbers need to total 100 (or all be 0 to leave it blank)');

  const ln = (input.links ?? {}) as Record<string, unknown>;
  const links: MetaLinks = { x: normalizeLink('x', ln.x), website: normalizeLink('website', ln.website), telegram: normalizeLink('telegram', ln.telegram) };
  return { description, split, links };
}

export function contentHash(c: MetaContent): Hex {
  return keccak256(toBytes(JSON.stringify([
    c.description,
    [c.split.creator, c.split.buyback, c.split.dividends, c.split.liquidity],
    [c.links.x, c.links.website, c.links.telegram],
  ])));
}

export const imageHash = (bytes: Uint8Array): Hex => sha256(bytes);

/** Image types we accept, identified by magic bytes rather than the declared type. */
export function sniffImage(b: Uint8Array): { ext: string; type: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: 'gif', type: 'image/gif' };
  return null;
}

/**
 * The exact text the creator's wallet signs (EIP-191 personal_sign). The
 * create page builds it to sign and /api/metadata rebuilds it to verify, both
 * through this one function, so the two can never drift apart.
 */
export function metaMessage(p: { token: string; chainId: number; content: MetaContent; image: Hex | null; issuedAt: number }): string {
  return [
    'Robin Labs Pad: token details',
    `Token address: ${p.token.toLowerCase()}`,
    `Chain ID: ${p.chainId}`,
    `Details hash: ${contentHash(p.content)}`,
    `New image: ${p.image ?? 'none, keep current'}`,
    `Signed at: ${p.issuedAt}`,
  ].join('\n');
}
