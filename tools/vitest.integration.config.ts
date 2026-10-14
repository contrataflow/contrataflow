import { defineConfig } from 'vitest/config';

// Testes de tools/ que exigem Docker (PostgreSQL efêmero): estágios Testes/Migrações (US-079).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
