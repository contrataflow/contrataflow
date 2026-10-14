import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Os de test/integration/ exigem Docker: rodam em `test:integration` (estágio Testes do CI).
    exclude: ['test/integration/**', '**/node_modules/**'],
    // Os testes executam ESLint, dependency-cruiser, Turborepo e pnpm reais.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
