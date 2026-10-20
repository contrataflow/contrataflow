import { defineConfig } from 'vitest/config';

import unitConfig from './vitest.config';

// Integração com Testcontainers (Redis de sessões real — US-093): fora do `pnpm test`. Não usa
// `mergeConfig` — ele concatenaria o `include` dos testes de unidade.
export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: ['test/integration/**/*.spec.ts'],
    coverage: { enabled: false },
    testTimeout: 120_000,
    // O `beforeAll` sobe o contêiner (e baixa a imagem num runner novo do CI).
    hookTimeout: 120_000,
  },
});
