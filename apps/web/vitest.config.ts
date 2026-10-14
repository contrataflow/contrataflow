import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@test': fileURLToPath(new URL('./test', import.meta.url)),
      'server-only': fileURLToPath(new URL('./test/support/server-only.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    environment: 'node',
    setupFiles: ['test/support/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/i18n/next-intl.d.ts'],
    },
  },
});
