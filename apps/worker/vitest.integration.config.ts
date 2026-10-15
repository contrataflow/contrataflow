import { defineConfig, mergeConfig } from 'vitest/config';

import unitConfig from './vitest.config.js';

// Integração com Testcontainers (PostgreSQL com RLS, Redis — relay do outbox da US-082).
export default mergeConfig(
  unitConfig,
  defineConfig({
    test: {
      include: ['test/**/*.spec.ts'],
      testTimeout: 120_000,
      // O `beforeAll` sobe contêineres (e baixa a imagem num runner novo do CI): o padrão de
      // 10 s do Vitest para hooks estoura de forma intermitente.
      hookTimeout: 120_000,
    },
  }),
);
