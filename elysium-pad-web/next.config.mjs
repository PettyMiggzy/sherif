/** @type {import('next').NextConfig} */
// next/image is never used, so the image optimizer stays off: with an open
// remotePatterns ('**') it would make /_next/image a proxy for any https URL.
const nextConfig = { reactStrictMode: true, images: { unoptimized: true } };
export default nextConfig;
