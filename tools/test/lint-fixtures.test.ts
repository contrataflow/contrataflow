import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { lintTree, toPosix } from './support/analyzers.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/lint/', import.meta.url));

/** Uma fixture por proibição (RN-FND-03 e RN-FND-06) e a regra que deve reprová-la. */
const EXPECTED: Record<string, readonly string[]> = {
  'violations/apps/api/src/modules/process/infrastructure/unsafe-raw-query.ts': [
    'contrataflow/no-unsafe-raw-query',
  ],
  'violations/apps/api/src/modules/process/application/logs-with-console.ts': [
    'contrataflow/no-console',
  ],
  'violations/apps/api/src/modules/process/application/reads-process-env.ts': [
    'contrataflow/no-process-env',
  ],
  'violations/apps/api/src/modules/process/application/dynamic-code.ts': [
    'contrataflow/no-dynamic-code',
  ],
  'violations/apps/web/src/features/processes/raw-html.tsx': ['contrataflow/no-dangerous-html'],
  'violations/apps/api/src/modules/process/application/redis-direct.ts': [
    'contrataflow/no-direct-redis',
  ],
  'violations/apps/api/src/modules/process/domain/process-prisma.ts': [
    'contrataflow/no-prisma-outside-infrastructure',
  ],
  'violations/apps/web/src/bff/session-store.ts': ['contrataflow/require-server-only'],
  'violations/packages/types/src/explicit-any.ts': ['@typescript-eslint/no-explicit-any'],
  'violations/packages/types/src/ts-ignore.ts': ['@typescript-eslint/ban-ts-comment'],
  'violations/packages/types/src/ts-nocheck.ts': ['@typescript-eslint/ban-ts-comment'],
  'violations/packages/types/src/ts-expect-error-short.ts': ['@typescript-eslint/ban-ts-comment'],
};

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(path.relative(FIXTURES, path.join(entry.parentPath, entry.name))))
    .sort();
}

describe('fixtures de lint (RN-FND-03/06)', async () => {
  const byFile = await lintTree(FIXTURES);

  it('existe exatamente uma fixture de violação por proibição', () => {
    expect(listFiles(path.join(FIXTURES, 'violations'))).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s é reprovada', (file, rules) => {
    const messages = byFile.get(file) ?? [];
    expect(messages.every((message) => message.severity === 2)).toBe(true);
    expect([...new Set(messages.map((message) => message.ruleId))]).toEqual(rules);
  });

  it('as mensagens orientam a correção e citam o guia de segurança', () => {
    for (const [file] of Object.entries(EXPECTED)) {
      for (const message of byFile.get(file) ?? []) {
        if (message.ruleId?.startsWith('contrataflow/')) {
          expect(message.message).toContain('CONTRIBUTING.md §Segurança');
        }
      }
    }
  });

  it.each(listFiles(path.join(FIXTURES, 'allowed')))('%s é permitido', (file) => {
    expect(byFile.get(file)).toEqual([]);
  });
});
