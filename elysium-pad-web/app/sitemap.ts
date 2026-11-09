import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteApi';

export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const s = siteUrl();
  return ['', '/create', '/explore', '/deals', '/leaderboard', '/docs', '/about', '/arena', '/llms.txt', '/llms-full.txt', '/api/v1/openapi.json', '/.well-known/mcp/server-card.json']
    .map((p) => ({ url: `${s}${p}`, changeFrequency: 'hourly' as const }));
}
