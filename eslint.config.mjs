// Arquivos da raiz do repositório. Cada pacote em apps/, packages/ e tools/ tem o próprio
// eslint.config.mjs (lint-staged usa a busca de configuração a partir do arquivo).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig(
  {
    ignores: [
      'apps/**',
      'packages/**',
      'tools/**',
      'docs/**',
      '_work/**',
      'prototype/**',
      '.ddesktop/**',
      '.claude/**',
      '**/node_modules/**',
      '**/.turbo/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2024, globals: { ...globals.node } },
  },
);
