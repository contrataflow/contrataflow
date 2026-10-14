import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

import { assertPublicEnv } from './src/config/env';

// V-04 (RN-FND-88 · architecture.md §8.3): `NEXT_PUBLIC_*` fora da lista fechada falha o build.
assertPublicEnv(process.env);

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Design system consumido como pacote do workspace (CSS e componentes).
  transpilePackages: ['@contrataflow/ui'],
};

export default withNextIntl(nextConfig);
