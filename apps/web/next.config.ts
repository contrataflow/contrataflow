import { existsSync } from 'node:fs';
import path from 'node:path';

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

import { assertPublicEnv } from './src/config/env';

// `.env` da raiz do monorepo. Carregado aqui, e não com `node --env-file`, porque o `next dev`
// repassa as flags do Node aos processos filhos via NODE_OPTIONS, que recusa `--env-file`. Não
// sobrescreve variáveis já definidas no ambiente (CI e Playwright continuam mandando).
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

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
