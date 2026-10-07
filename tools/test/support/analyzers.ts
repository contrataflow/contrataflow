import { createRequire } from 'node:module';
import path from 'node:path';

import { base } from '@contrataflow/eslint-config/base';
import { security } from '@contrataflow/eslint-config/security';
import { cruise } from 'dependency-cruiser';
import type { ICruiseOptions, ICruiseResult, IViolation } from 'dependency-cruiser';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { REPO_ROOT } from '../../lib/workspace.js';

/** Caminho relativo com `/`, independente do sistema operacional. */
export function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

/** Regras de RN-FND-03 copiadas da configuração base real (sem informação de tipos). */
function typescriptRules(): Linter.RulesRecord {
  const merged: Linter.RulesRecord = {};
  for (const config of base({ tsconfigRootDir: REPO_ROOT })) Object.assign(merged, config.rules);
  return {
    '@typescript-eslint/no-explicit-any': merged['@typescript-eslint/no-explicit-any'] ?? 'off',
    '@typescript-eslint/ban-ts-comment': merged['@typescript-eslint/ban-ts-comment'] ?? 'off',
  };
}

/** ESLint com as proibições de segurança reais, aplicado sobre uma árvore de fixtures. */
export function createSecurityLinter(cwd: string): ESLint {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: typescriptRules(),
      },
      ...security(),
    ],
  });
}

/** Mensagens do ESLint por arquivo (caminho relativo a `cwd`). */
export async function lintTree(cwd: string): Promise<Map<string, Linter.LintMessage[]>> {
  const results = await createSecurityLinter(cwd).lintFiles(['**/*.{ts,tsx}']);
  return new Map(
    results.map((result) => [toPosix(path.relative(cwd, result.filePath)), result.messages]),
  );
}

const require = createRequire(import.meta.url);

/** Configuração real do .dependency-cruiser.cjs da raiz. */
export function loadDepcruiseConfig(): { forbidden: { name: string }[]; options: ICruiseOptions } {
  return require(path.join(REPO_ROOT, '.dependency-cruiser.cjs')) as {
    forbidden: { name: string }[];
    options: ICruiseOptions;
  };
}

/** Executa o dependency-cruiser com as regras reais sobre uma árvore que imita o monorepo. */
export async function cruiseTree(baseDir: string, roots: string[]): Promise<IViolation[]> {
  const { forbidden, options } = loadDepcruiseConfig();
  const cruiseOptions = {
    ...options,
    baseDir,
    validate: true,
    ruleSet: { forbidden },
  } as ICruiseOptions;
  const result = await cruise(roots, cruiseOptions);
  const output = result.output as ICruiseResult;
  return output.summary.violations;
}
