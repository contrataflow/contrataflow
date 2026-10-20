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
  // Logger e OpenTelemetry carregados pelo Node em runtime, fora do bundle do servidor: o SDK
  // depende de `require` dinâmico (instrumentações) e de módulos nativos do Node (US-084).
  serverExternalPackages: [
    '@contrataflow/observability',
    // Cliente do Redis de sessões (US-087): módulos nativos do Node (net/tls).
    'ioredis',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-undici',
  ],
};

export default withNextIntl(nextConfig);
