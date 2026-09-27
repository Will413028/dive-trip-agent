import type { NextConfig } from 'next';

const config: NextConfig = { devIndicators: false, poweredByHeader: false,
  async headers() { return [{ source: '/share/:path*', headers: [
    { key: 'Cache-Control', value: 'no-store' }, { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ] }]; },
};
export default config;
