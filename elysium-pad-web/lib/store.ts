import 'server-only';
import { BlobPreconditionFailedError, get, put } from '@vercel/blob';

// The site's only storage: a private Vercel Blob store that belongs to this
// project alone (BLOB_READ_WRITE_TOKEN, set by Vercel when the store is
// connected). Everything is read back through this site's own routes, so
// visitors never see a storage hostname. Reads skip the CDN cache, so a
// write is visible to the very next request.

const ACCESS = 'private' as const;

export function storeConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function readRaw(pathname: string): Promise<{ bytes: Buffer; contentType: string; etag: string } | null> {
  const r = await get(pathname, { access: ACCESS, useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return { bytes: Buffer.from(await new Response(r.stream).arrayBuffer()), contentType: r.blob.contentType, etag: r.blob.etag };
}

export async function readJson<T>(pathname: string): Promise<{ value: T; etag: string } | null> {
  const r = await readRaw(pathname);
  return r ? { value: JSON.parse(r.bytes.toString('utf8')) as T, etag: r.etag } : null;
}

/**
 * Writes JSON. With `ifMatch` the write only lands if the blob still has that
 * ETag (returns false otherwise); `ifMatch: null` means "only if it doesn't
 * exist yet".
 */
export async function writeJson(pathname: string, value: unknown, opts: { ifMatch?: string | null } = {}): Promise<boolean> {
  try {
    await put(pathname, JSON.stringify(value), {
      access: ACCESS,
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: opts.ifMatch !== null,
      cacheControlMaxAge: 60,
      ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
    });
    return true;
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) return false;
    // allowOverwrite: false on an existing blob
    if ((e as Error)?.message?.includes('already exists')) return false;
    throw e;
  }
}

export async function readFile(pathname: string) {
  return readRaw(pathname);
}

export async function writeFile(pathname: string, bytes: Buffer, contentType: string): Promise<void> {
  await put(pathname, bytes, { access: ACCESS, contentType, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 * 60 * 24 * 365 });
}

// ---------------------------------------------------------------------------
// Token info (description, image, links), written by the token's creator
// ---------------------------------------------------------------------------

export type TokenMeta = {
  token: string;
  name: string;
  symbol: string;
  description: string;
  /** Content hash + extension of the current image, or null. */
  imageKey: string | null;
  imageType: string | null;
  split: { creator: number; buyback: number; dividends: number; liquidity: number };
  links: { x?: string; website?: string; telegram?: string };
  createdAt: number;
  /** Unix seconds of the creator signature behind this version. */
  signedAt: number;
};

const metaPath = (token: string) => `meta/${token.toLowerCase()}.json`;
const imagePath = (token: string, key: string) => `img/${token.toLowerCase()}/${key}`;

export async function getTokenMeta(token: string): Promise<TokenMeta | null> {
  return (await readJson<TokenMeta>(metaPath(token)))?.value ?? null;
}

/**
 * Saves a creator-signed update. Returns false when the stored version
 * already carries a signature at least as new (a replayed or stale write).
 * A write without a new image keeps the current one.
 */
export async function saveTokenMeta(
  next: Omit<TokenMeta, 'imageKey' | 'imageType'>,
  image: { key: string; type: string; bytes: Buffer } | null,
): Promise<boolean> {
  if (image) await writeFile(imagePath(next.token, image.key), image.bytes, image.type);
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readJson<TokenMeta>(metaPath(next.token));
    if (cur && cur.value.signedAt >= next.signedAt) return false;
    const row: TokenMeta = {
      ...next,
      imageKey: image?.key ?? cur?.value.imageKey ?? null,
      imageType: image?.type ?? cur?.value.imageType ?? null,
    };
    if (await writeJson(metaPath(next.token), row, { ifMatch: cur ? cur.etag : null })) {
      if (image) await setIndexedImage(next.token, image.key);
      return true;
    }
    // someone else wrote in between: re-read and re-check the signature age
  }
  throw new Error('token info is being updated concurrently, try again');
}

// token -> current image key, so lists (the market feed, cards) can show
// images with one read instead of one per token.
const IMAGE_INDEX = 'index/images.json';

export async function getImageIndex(): Promise<Record<string, string>> {
  return (await readJson<Record<string, string>>(IMAGE_INDEX))?.value ?? {};
}

async function setIndexedImage(token: string, key: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readJson<Record<string, string>>(IMAGE_INDEX);
    const next = { ...(cur?.value ?? {}), [token.toLowerCase()]: key };
    if (await writeJson(IMAGE_INDEX, next, { ifMatch: cur ? cur.etag : null })) return;
  }
  console.error('image index update gave up after 5 tries', token);
}

export async function getTokenImage(token: string): Promise<{ key: string; type: string; bytes: Buffer } | null> {
  const meta = await getTokenMeta(token);
  if (!meta?.imageKey) return null;
  const f = await readFile(imagePath(token, meta.imageKey));
  return f ? { key: meta.imageKey, type: meta.imageType || f.contentType, bytes: f.bytes } : null;
}
