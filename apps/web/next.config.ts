import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Design system consumido como pacote do workspace (CSS e componentes).
  transpilePackages: ['@contrataflow/ui'],
};

export default nextConfig;
