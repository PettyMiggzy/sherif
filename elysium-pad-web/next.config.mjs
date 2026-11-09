/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // next/image is never used, so the image optimizer stays off: with an open
  // remotePatterns ('**') it would make /_next/image a proxy for any https URL.
  images: { unoptimized: true },
  // A self-contained server (.next/standalone) for the Docker image; Vercel
  // ignores it. pg is loaded at runtime rather than bundled.
  output: 'standalone',
  experimental: { serverComponentsExternalPackages: ['pg'] },
  // www.elysiumpad.world -> elysiumpad.world, wherever the site is hosted.
  async redirects() {
    return [
      // The game lives in public/arena; its sprites load relative to this URL.
      { source: '/arena', destination: '/arena/index.html', permanent: false },
      { source: '/:path*', has: [{ type: 'host', value: 'www.elysiumpad.world' }], destination: 'https://elysiumpad.world/:path*', permanent: true },
    ];
  },
};
export default nextConfig;
