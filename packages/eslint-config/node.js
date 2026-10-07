import { defineConfig } from 'eslint/config';
import globals from 'globals';

import { base } from './base.js';

/**
 * Pacotes e scripts executados no Node.js 24.
 * @param {import('./base.js').ConfigOptions} options
 */
export function node(options) {
  return defineConfig(base(options), {
    name: 'contrataflow/node',
    languageOptions: { globals: { ...globals.node } },
  });
}
