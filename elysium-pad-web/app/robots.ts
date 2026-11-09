import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteApi';

// Open to everyone, AI crawlers included: being found is the point.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
