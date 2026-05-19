/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: true,
  },
  // In dev, proxy /api/* to the backend so cookies are same-origin without
  // CORS. In production, Nginx does the same thing, so this rewrite is a
  // no-op behind the reverse proxy.
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const target = process.env.BACKEND_URL || 'http://127.0.0.1:4000';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};

export default nextConfig;
