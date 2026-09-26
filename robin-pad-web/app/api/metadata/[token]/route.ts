import { NextRequest, NextResponse } from 'next/server';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { getTokenMeta, saveTokenMeta, storeConfigured, type TokenMeta } from '@/lib/store';
import { getLaunches, chainClient } from '@/lib/launches';
import { splitterAbi } from '@/lib/abi';
import { CONFIG } from '@/lib/config';
import { MAX_IMAGE_BYTES, SIG_MAX_AGE_SEC, imageHash, metaMessage, normalizeContent, sniffImage } from '@/lib/metaAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Off-chain display metadata only — nothing here is consulted by any
// contract. Every write must be signed by the token's current on-chain
// creator (see lib/metaAuth.ts), so nobody else can change a token's
// description, image or links.

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

function toJson(row: TokenMeta) {
  // Links are only shown from a version that carries a creator signature;
  // without one nothing vouches for them.
  const signed = row.signedAt > 0;
  return {
    token: row.token,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    // Served from this site (see ./image/route.ts); the key is the image's
    // content hash, so a new image gets a new URL and caches never go stale.
    image: row.imageKey ? `/api/metadata/${row.token}/image?v=${encodeURIComponent(row.imageKey)}` : null,
    split: row.split,
    links: signed ? row.links : {},
    createdAt: row.createdAt,
  };
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token.toLowerCase();
  if (!isAddress(token)) return bad('That is not a token address');
  if (!storeConfigured()) return NextResponse.json(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  try {
    const row = await getTokenMeta(token);
    if (!row) return NextResponse.json(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    return NextResponse.json(toJson(row), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('GET /api/metadata failed', e);
    return bad('Token details are unreachable for a moment. Try again shortly.', 503);
  }
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token.toLowerCase();
  if (!isAddress(token)) return bad('That is not a token address');
  if (!storeConfigured()) return bad('Saving token details is switched off on this site.', 503);
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES + 64 * 1024) return bad('That upload is too big (4 MB max).', 413);

  // @types/node's ambient FormData augmentation shadows lib.dom's fuller
  // type here; the object is a spec-compliant FormData at runtime regardless.
  let form: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { form = await req.formData(); } catch { return bad('Send the details as a form upload.'); }

  let content;
  try {
    content = normalizeContent({
      description: form.get('description'),
      split: JSON.parse(String(form.get('split') ?? '{}')),
      links: JSON.parse(String(form.get('links') ?? '{}')),
    });
  } catch (e) {
    return bad(e instanceof SyntaxError ? 'The split and links fields have to be JSON.' : (e as Error).message);
  }

  const issuedAt = Number(form.get('issuedAt'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(issuedAt) || issuedAt < now - SIG_MAX_AGE_SEC || issuedAt > now + 60) return bad('That signature is too old. Sign once more.', 401);
  const signature = String(form.get('signature') ?? '');
  if (!isHex(signature) || signature.length < 132) return bad('No wallet signature came with the details.', 401);

  let image: { bytes: Buffer; ext: string; type: string; hash: Hex } | null = null;
  const file = form.get('image');
  if (file && typeof file === 'object' && 'arrayBuffer' in file) {
    if (file.size > MAX_IMAGE_BYTES) return bad('That image is over 4 MB.', 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    const kind = sniffImage(bytes);
    if (!kind) return bad('Images have to be PNG, JPG or GIF.');
    image = { bytes, ...kind, hash: imageHash(bytes) };
  }

  try {
    // Only launches this pad's portal actually created, and only their
    // current creator (the splitter tracks two-step creator transfers).
    const { launches, stale } = await getLaunches(token);
    const launch = launches[0];
    if (!launch) return bad(stale ? 'The launch list is catching up. Try again in a moment.' : 'Robin Labs Pad did not launch that token.', stale ? 503 : 404);
    const creator = await chainClient.readContract({ address: launch.splitter, abi: splitterAbi, functionName: 'creator' });

    const message = metaMessage({ token, chainId: CONFIG.chainId, content, image: image?.hash ?? null, issuedAt });
    const ok = await chainClient.verifyMessage({ address: creator as Address, message, signature: signature as Hex });
    if (!ok) return bad('Only the wallet that created this token can edit its details.', 403);

    const written = await saveTokenMeta({
      token, name: launch.name, symbol: launch.symbol, description: content.description,
      split: content.split,
      links: { x: content.links.x || undefined, website: content.links.website || undefined, telegram: content.links.telegram || undefined },
      createdAt: Date.now(), signedAt: issuedAt,
    }, image && { key: `${image.hash.slice(2, 18)}.${image.ext}`, type: image.type, bytes: image.bytes });
    if (!written) return bad('A more recent edit is already saved.', 409);
    return NextResponse.json({ ok: true, imageSaved: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('POST /api/metadata failed', e);
    return bad('Token details are unreachable for a moment. Try again shortly.', 503);
  }
}
