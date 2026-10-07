import { defineConfig, mergeConfig } from 'vitest/config';

import unitConfig from './vitest.config.js';

// Integração com Testcontainers (PostgreSQL com RLS, Redis, MinIO): US-078/US-079.
export default mergeConfig(
  unitConfig,
  defineConfig({
    test: {
      include: ['test/**/*.spec.ts'],
      testTimeout: 120_000,
    },
  }),
);
