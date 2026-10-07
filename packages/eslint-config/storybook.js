import { defineConfig } from 'eslint/config';

import { DEV_FILES } from './base.js';

/** Histórias do Storybook (o plugin eslint-plugin-storybook entra com a US-086). */
export const STORY_FILES = ['**/*.stories.{ts,tsx}', '**/.storybook/**/*.{ts,tsx}'];

/**
 * Ajustes para histórias; combine depois de `react()`/`next()`.
 */
export function storybook() {
  return defineConfig({
    name: 'contrataflow/storybook',
    files: STORY_FILES,
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: [...DEV_FILES, ...STORY_FILES], includeTypes: true },
      ],
      'import-x/no-anonymous-default-export': 'off',
    },
  });
}
