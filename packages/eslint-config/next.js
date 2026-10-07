import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

import { react } from './react.js';

/**
 * apps/web (Next.js App Router + BFF).
 * @param {import('./base.js').ConfigOptions} options
 */
export function next(options) {
  return defineConfig(react(options), {
    name: 'contrataflow/next',
    extends: [nextPlugin.configs['core-web-vitals']],
    languageOptions: { globals: { ...globals.node } },
  });
}
