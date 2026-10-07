import { defineConfig } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import { base } from './base.js';

/** Componentes React (web e ui): acessibilidade desde o primeiro componente. */
export const REACT_FILES = ['**/*.{tsx,jsx}'];

/**
 * @param {import('./base.js').ConfigOptions} options
 */
export function react(options) {
  return defineConfig(base(options), {
    name: 'contrataflow/react',
    files: REACT_FILES,
    extends: [jsxA11y.flatConfigs.strict, reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });
}
