import type { Address, Hex } from 'viem';
import { CONFIG } from './config';
import { MAX_IMAGE_BYTES, imageHash, metaMessage, normalizeContent } from './metaAuth';

// Off-chain only: createLaunch takes no image, description or social links,
// so these are purely for display and nothing on-chain reads them. This
// site's own /api/metadata route stores them (image included), and every
// write must be signed by the token's on-chain creator (lib/metaAuth.ts).
// A copy is kept in this browser's localStorage so the creator sees their own
// save immediately.
export type TokenMeta = {
  token: string;
  name: string;
  symbol: string;
  description: string;
  image: string | null; // this site's /api/metadata/<token>/image URL, or a data URL in the local copy
  split: { creator: number; buyback: number; dividends: number; liquidity: number };
  links?: { x?: string; website?: string; telegram?: string };
  createdAt: number;
};

const LS_KEY = 'robinpad:meta';

function lsAll(): Record<string, TokenMeta> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Saves display metadata for `token`, signed by the connected wallet — which
 * must be the token's current creator or the server rejects it. `sign` is
 * wagmi's signMessageAsync.
 */
export async function saveMeta(
  m: TokenMeta,
  imageFile: File | null | undefined,
  sign: (args: { message: string }) => Promise<Hex>,
): Promise<{ imageSaved: boolean }> {
  const key = m.token.toLowerCase();
  const content = normalizeContent({ description: m.description, split: m.split, links: m.links ?? {} });
  let image: Hex | null = null;
  if (imageFile) {
    if (imageFile.size > MAX_IMAGE_BYTES) throw new Error('Pictures can be up to 4 MB');
    image = imageHash(new Uint8Array(await imageFile.arrayBuffer()));
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await sign({ message: metaMessage({ token: key, chainId: CONFIG.chainId, content, image, issuedAt }) });

  const form = new FormData();
  form.set('description', content.description);
  form.set('split', JSON.stringify(content.split));
  form.set('links', JSON.stringify(content.links));
  form.set('issuedAt', String(issuedAt));
  form.set('signature', signature);
  if (imageFile) form.set('image', imageFile);
  const res = await fetch(`/api/metadata/${key}`, { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as { error?: string; imageSaved?: boolean };
  if (!res.ok) throw new Error(body.error ?? `The server didn't save the details (${res.status})`);

  const all = lsAll();
  all[key] = { ...m, description: content.description, split: content.split, links: content.links };
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch { /* quota — the server copy is what counts */ }
  return { imageSaved: body.imageSaved !== false };
}

export async function loadMeta(token: Address): Promise<TokenMeta | null> {
  const key = token.toLowerCase();
  // Always this site's /api/metadata, where every write is creator-signed;
  // pad-indexer serves no token metadata.
  const r = await fetch(`/api/metadata/${key}`).catch(() => null);
  if (r?.ok) {
    const body = await r.json().catch(() => null);
    if (body) return body;
  }
  return lsAll()[key] ?? null;
}

/** Client-side validation matching the create form: PNG/JPG/GIF, ≤4 MB. Returns a data URL. */
export function readImageFile(file: File): Promise<string> {
  return new Promise((res, rej) => {
    if (!/^image\/(png|jpeg|gif)$/.test(file.type)) return rej(new Error('Only PNG, JPEG and GIF images work here'));
    if (file.size > MAX_IMAGE_BYTES) return rej(new Error('That picture is over 4 MB'));
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error("Couldn't open that file"));
    fr.readAsDataURL(file);
  });
}
