import { defineConfig } from 'eslint/config';

import { node } from './node.js';

/**
 * apps/api e apps/worker (NestJS 11, ESM).
 * @param {import('./base.js').ConfigOptions} options
 */
export function nest(options) {
  return defineConfig(node(options), {
    name: 'contrataflow/nest',
    rules: {
      // Módulos Nest são classes vazias decoradas com @Module.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  });
}
