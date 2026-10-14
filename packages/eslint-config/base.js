import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

import { security } from './security.js';

/** Pastas geradas nunca analisadas. */
export const GLOBAL_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/next-env.d.ts',
];

/** Arquivos de teste e de configuração (podem importar devDependencies). */
export const DEV_FILES = [
  '**/*.{spec,test}.{ts,tsx,mts,js,mjs}',
  '**/test/**',
  '**/*.config.{ts,mts,cts,js,mjs,cjs}',
];

/**
 * @typedef {object} ConfigOptions
 * @property {string} tsconfigRootDir diretório do pacote (`import.meta.dirname`)
 */

/**
 * Base de todos os pacotes: TypeScript *type-checked* estrito, import-x e as
 * proibições de segurança (RN-FND-03/06).
 * @param {ConfigOptions} options
 */
export function base({ tsconfigRootDir }) {
  return defineConfig(
    { name: 'contrataflow/ignores', ignores: GLOBAL_IGNORES },
    { name: 'contrataflow/linter', linterOptions: { reportUnusedDisableDirectives: 'error' } },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    importX.flatConfigs.recommended,
    importX.flatConfigs.typescript,
    {
      name: 'contrataflow/typescript',
      languageOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      settings: {
        'import-x/resolver-next': [
          // `project` fixo no pacote: os aliases do tsconfig (ex.: `@/*` do web) resolvem mesmo
          // quando o ESLint roda da raiz (lint-staged), não só dentro do pacote (turbo).
          createTypeScriptImportResolver({ alwaysTryTypes: true, project: tsconfigRootDir }),
          createNodeResolver(),
        ],
      },
      rules: {
        // RN-FND-03: `any` explícito, @ts-ignore e @ts-nocheck proibidos.
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/ban-ts-comment': [
          'error',
          {
            'ts-expect-error': 'allow-with-description',
            'ts-ignore': true,
            'ts-nocheck': true,
            'ts-check': false,
            minimumDescriptionLength: 10,
          },
        ],
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
        ],
        '@typescript-eslint/consistent-type-exports': 'error',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
        ],
        eqeqeq: ['error', 'always'],
        'no-implicit-coercion': 'error',
        'import-x/no-extraneous-dependencies': [
          'error',
          { devDependencies: DEV_FILES, includeTypes: true },
        ],
        'import-x/no-duplicates': 'error',
        // Redundantes com o TypeScript e ruidosas com pacotes que exportam `default` + nomes.
        'import-x/no-named-as-default': 'off',
        'import-x/no-named-as-default-member': 'off',
        'import-x/order': [
          'error',
          {
            groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],
      },
    },
    {
      name: 'contrataflow/javascript',
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    security(),
  );
}
