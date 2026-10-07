import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ownersOf, parseCodeowners, patternToRegExp } from '../lib/codeowners.js';
import { REPO_ROOT } from '../lib/workspace.js';

const rules = parseCodeowners(readFileSync(path.join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8'));

const TECH_LEAD = '@contrataflow/tech-lead';
const SECURITY = '@contrataflow/security';

describe('CODEOWNERS (Permissões da US-077)', () => {
  it('[Permissão] PR em modules/access e pnpm-workspace.yaml pede Tech Lead e segurança', () => {
    for (const file of [
      'apps/api/src/modules/access/application/role.facade.ts',
      'pnpm-workspace.yaml',
    ]) {
      expect(ownersOf(rules, file)).toEqual(expect.arrayContaining([TECH_LEAD, SECURITY]));
    }
  });

  it.each([
    'apps/api/src/shared/request-context.ts',
    'apps/api/src/modules/identity/domain/user.ts',
    'apps/api/src/modules/tenancy/tenancy.module.ts',
    'apps/api/src/modules/audit/application/audit.facade.ts',
    'apps/api/src/modules/platform/infrastructure/outbox.ts',
    'apps/api/prisma/schema.prisma',
    'apps/web/src/bff/session-store.ts',
    '.github/workflows/ci.yml',
    '.npmrc',
    'renovate.json5',
    '.dependency-cruiser.cjs',
    'packages/eslint-config/security.js',
  ])('área sensível %s exige Tech Lead e segurança', (file) => {
    expect(ownersOf(rules, file)).toEqual(expect.arrayContaining([TECH_LEAD, SECURITY]));
  });

  it('design system é do front-end e design; especificação é do Tech Lead e PO', () => {
    expect(ownersOf(rules, 'packages/ui/src/index.ts')).toEqual([
      '@contrataflow/frontend',
      '@contrataflow/design',
    ]);
    expect(ownersOf(rules, 'docs/mvp-01/entities.md')).toEqual([
      TECH_LEAD,
      '@contrataflow/product',
    ]);
  });

  it('demais arquivos ficam com o time de engenharia', () => {
    expect(ownersOf(rules, 'apps/api/src/modules/process/domain/process.aggregate.ts')).toEqual([
      '@contrataflow/engineering',
    ]);
  });
});

describe('padrões do CODEOWNERS', () => {
  it.each([
    ['/apps/api/src/shared/', 'apps/api/src/shared/a/b.ts', true],
    ['/apps/api/src/shared/', 'apps/api/src/shared-kernel/a.ts', false],
    ['/pnpm-workspace.yaml', 'pnpm-workspace.yaml', true],
    ['/pnpm-workspace.yaml', 'apps/pnpm-workspace.yaml', false],
    ['*.md', 'docs/README.md', true],
    ['docs/**/*.md', 'docs/mvp-01/api/01.md', true],
    ['docs/**/*.md', 'docs/a.md', true],
    ['/apps/*/package.json', 'apps/web/package.json', true],
    ['/apps/*/package.json', 'apps/web/src/package.json', false],
    ['apps/**', 'apps/web/src/a.ts', true],
    ['README?.md', 'README1.md', true],
  ])('%s casa com %s: %s', (pattern, file, expected) => {
    expect(patternToRegExp(pattern).test(file)).toBe(expected);
  });

  it('ignora comentários e linhas vazias', () => {
    expect(parseCodeowners('# comentário\n\n/a/ @x # fim\n')).toMatchObject([
      { line: 3, pattern: '/a/', owners: ['@x'] },
    ]);
    expect(ownersOf(parseCodeowners('/a/ @x'), '/a/b.ts')).toEqual(['@x']);
    expect(ownersOf(parseCodeowners('/a/ @x'), 'b/c.ts')).toEqual([]);
  });
});
