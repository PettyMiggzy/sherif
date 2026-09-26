import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getTokenImage } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A token's image, from the site's private Blob store. Only PNG, JPG and GIF
// are ever stored (the upload is sniffed in ../route.ts), and the headers
// below stop a browser from treating the bytes as anything else.
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token.toLowerCase();
  if (!isAddress(token)) return new NextResponse('That is not a token address', { status: 400 });
  try {
    const img = await getTokenImage(token);
    if (!img) return new NextResponse('no image', { status: 404, headers: { 'cache-control': 'no-store' } });
    // The metadata route links ?v=<content hash>; that exact URL never changes
    // content, so it can be cached for good. Anything else revalidates.
    const pinned = req.nextUrl.searchParams.get('v') === img.key;
    return new NextResponse(new Uint8Array(img.bytes), {
      headers: {
        'content-type': img.type,
        'content-length': String(img.bytes.length),
        'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
        // Other sites (robinlab.io, for one) show these icons too.
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
      },
    });
  } catch (e) {
    console.error('GET /api/metadata/[token]/image failed', e);
    return new NextResponse('image unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
