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
  },
});
