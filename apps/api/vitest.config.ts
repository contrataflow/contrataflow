import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  // SWC emite os metadados de decorators exigidos pela injeção do NestJS (esbuild não emite).
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    // Subpath imports (#config/*, #shared/*, #modules/*) apontam para o código-fonte nos testes.
    alias: [{ find: /^#(config|shared|modules)\/(.*)\.js$/, replacement: `${src}/$1/$2.ts` }],
  },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // lcov alimenta o gate de cobertura do código novo do CI (US-079 — RN-FND-24); `include`
    // faz arquivos sem teste aparecerem com 0% em vez de sumirem do relatório.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/main.ts',
        'src/otel.ts',
        'src/shared/database/generated/**',
      ],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
