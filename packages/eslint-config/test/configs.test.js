import { describe, expect, it } from 'vitest';

import { base } from '../base.js';
import { nest } from '../nest.js';
import { next } from '../next.js';
import { node } from '../node.js';
import { react } from '../react.js';
import { security, SECURITY_ALLOWLISTS } from '../security.js';
import { storybook } from '../storybook.js';

const options = { tsconfigRootDir: import.meta.dirname };

const SECURITY_RULES = [
  'contrataflow/no-unsafe-raw-query',
  'contrataflow/no-dynamic-code',
  'contrataflow/no-console',
  'contrataflow/no-process-env',
  'contrataflow/no-direct-redis',
  'contrataflow/no-prisma-outside-infrastructure',
  'contrataflow/no-prisma-client-outside-database',
  'contrataflow/no-dangerous-html',
  'contrataflow/require-server-only',
];

/** @param {import('eslint').Linter.Config[]} configs */
function enabledRules(configs) {
  return new Set(configs.flatMap((config) => Object.keys(config.rules ?? {})));
}

describe('fábricas de configuração', () => {
  it.each([
    ['base', base(options)],
    ['node', node(options)],
    ['nest', nest(options)],
    ['react', react(options)],
    ['next', next(options)],
  ])('%s inclui todas as proibições de segurança como erro', (_name, configs) => {
    const rules = enabledRules(configs);
    for (const rule of SECURITY_RULES) expect(rules.has(rule)).toBe(true);
    for (const config of configs) {
      for (const [rule, level] of Object.entries(config.rules ?? {})) {
        if (rule.startsWith('contrataflow/')) expect(level).toBe('error');
      }
    }
  });

  it('base proíbe any explícito e @ts-ignore', () => {
    const rules = Object.assign({}, ...base(options).map((config) => config.rules ?? {}));
    expect(rules['@typescript-eslint/no-explicit-any']).toBe('error');
    expect(rules['@typescript-eslint/ban-ts-comment']).toEqual([
      'error',
      expect.objectContaining({
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-expect-error': 'allow-with-description',
        minimumDescriptionLength: 10,
      }),
    ]);
  });

  it('react ativa jsx-a11y e next ativa o plugin do Next.js', () => {
    expect(enabledRules(react(options)).has('jsx-a11y/alt-text')).toBe(true);
    expect(enabledRules(next(options)).has('@next/next/no-html-link-for-pages')).toBe(true);
  });

  it('storybook só afeta arquivos de histórias', () => {
    for (const config of storybook()) expect(config.files).toContain('**/*.stories.{ts,tsx}');
  });

  it('libera cada API proibida somente nos caminhos documentados', () => {
    const byName = Object.fromEntries(security().map((config) => [config.name, config]));
    expect(byName['contrataflow/security/redis']?.ignores).toEqual(SECURITY_ALLOWLISTS.redis);
    expect(byName['contrataflow/security/prisma']?.ignores).toEqual(SECURITY_ALLOWLISTS.prisma);
    expect(byName['contrataflow/security/prisma-client']?.ignores).toEqual(
      SECURITY_ALLOWLISTS.prismaClient,
    );
    expect(byName['contrataflow/security/process-env']?.ignores).toEqual(
      SECURITY_ALLOWLISTS.processEnv,
    );
    expect(byName['contrataflow/security/always']?.ignores).toBeUndefined();
  });
});
