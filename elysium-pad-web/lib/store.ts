import 'server-only';
import { randomUUID } from 'node:crypto';
import { BlobPreconditionFailedError, get, put } from '@vercel/blob';
import { Pool } from 'pg';

// The site's only storage, behind one small interface (read a file, write a
// file, optionally only if it still has the version you read). Two backends:
//   - a private Vercel Blob store (BLOB_READ_WRITE_TOKEN, set by Vercel when
//     the store is connected), when the site runs on Vercel;
//   - a Postgres table (DATABASE_URL, e.g. Neon), when the site runs as its
//     own server (the Docker image in this folder).
// Everything is read back through this site's own routes, so visitors never
// see a storage hostname, and a write is visible to the very next request.

type Raw = { bytes: Buffer; contentType: string; etag: string };
type WriteOpts = { ifMatch?: string | null; cacheMaxAge?: number };

interface Backend {
  read(pathname: string): Promise<Raw | null>;
  /**
   * `ifMatch`: only write if the file still has that ETag; `null`: only if it
   * doesn't exist yet; omitted: always. False when that condition failed.
   */
  write(pathname: string, bytes: Buffer, contentType: string, opts: WriteOpts): Promise<boolean>;
}

const ACCESS = 'private' as const;

const blobBackend: Backend = {
  async read(pathname) {
    const r = await get(pathname, { access: ACCESS, useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return { bytes: Buffer.from(await new Response(r.stream).arrayBuffer()), contentType: r.blob.contentType, etag: r.blob.etag };
  },
  async write(pathname, bytes, contentType, opts) {
    try {
      await put(pathname, bytes, {
        access: ACCESS,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: opts.ifMatch !== null,
        cacheControlMaxAge: opts.cacheMaxAge ?? 60,
        ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
      });
      return true;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) return false;
      // allowOverwrite: false on an existing blob
      if ((e as Error)?.message?.includes('already exists')) return false;
      throw e;
    }
  },
};

// One row per file. The ETag is a fresh random id on every write, so a
// conditional write ("only if it is still the version I read") is a plain
// UPDATE ... WHERE etag = $old, and "only if new" is an INSERT that skips
// on conflict. The table is created on first use.
let pool: Pool | null = null;
let ready: Promise<void> | null = null;
function pg(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 });
    pool.on('error', (e) => console.error('store: idle Postgres client error', e.message));
  }
  return pool;
}
function ensureTable(): Promise<void> {
  ready ??= pg().query(`CREATE TABLE IF NOT EXISTS site_store (
    path text PRIMARY KEY,
    bytes bytea NOT NULL,
    content_type text NOT NULL,
    etag text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`).then(() => undefined, (e) => { ready = null; throw e; });
  return ready;
}

const pgBackend: Backend = {
  async read(pathname) {
    await ensureTable();
    const r = await pg().query<{ bytes: Buffer; content_type: string; etag: string }>(
      'SELECT bytes, content_type, etag FROM site_store WHERE path = $1', [pathname]);
    const row = r.rows[0];
    return row ? { bytes: row.bytes, contentType: row.content_type, etag: row.etag } : null;
  },
  async write(pathname, bytes, contentType, opts) {
    await ensureTable();
    const etag = randomUUID();
    let r;
    if (opts.ifMatch === null) {
      r = await pg().query('INSERT INTO site_store (path, bytes, content_type, etag) VALUES ($1, $2, $3, $4) ON CONFLICT (path) DO NOTHING',
        [pathname, bytes, contentType, etag]);
    } else if (opts.ifMatch) {
      r = await pg().query('UPDATE site_store SET bytes = $2, content_type = $3, etag = $4, updated_at = now() WHERE path = $1 AND etag = $5',
        [pathname, bytes, contentType, etag, opts.ifMatch]);
    } else {
      r = await pg().query(`INSERT INTO site_store (path, bytes, content_type, etag) VALUES ($1, $2, $3, $4)
        ON CONFLICT (path) DO UPDATE SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type, etag = EXCLUDED.etag, updated_at = now()`,
        [pathname, bytes, contentType, etag]);
    }
    return r.rowCount === 1;
  },
};

function backend(): Backend {
  if (process.env.BLOB_READ_WRITE_TOKEN) return blobBackend;
  if (process.env.DATABASE_URL) return pgBackend;
  throw new Error('No storage is configured (set BLOB_READ_WRITE_TOKEN or DATABASE_URL)');
}

export function storeConfigured(): boolean {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.DATABASE_URL);
}

export async function readJson<T>(pathname: string): Promise<{ value: T; etag: string } | null> {
  const r = await backend().read(pathname);
  return r ? { value: JSON.parse(r.bytes.toString('utf8')) as T, etag: r.etag } : null;
}

/**
 * Writes JSON. With `ifMatch` the write only lands if the file still has that
 * ETag (returns false otherwise); `ifMatch: null` means "only if it doesn't
 * exist yet".
 */
export async function writeJson(pathname: string, value: unknown, opts: { ifMatch?: string | null } = {}): Promise<boolean> {
  return backend().write(pathname, Buffer.from(JSON.stringify(value)), 'application/json', { ifMatch: opts.ifMatch });
}

export async function readFile(pathname: string) {
  return backend().read(pathname);
}

export async function writeFile(pathname: string, bytes: Buffer, contentType: string): Promise<void> {
  await backend().write(pathname, bytes, contentType, { cacheMaxAge: 60 * 60 * 24 * 365 });
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
