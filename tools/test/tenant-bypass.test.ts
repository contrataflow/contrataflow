import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cruiseTree, lintTree } from './support/analyzers.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/tenant-bypass/', import.meta.url));
const MODULE = 'apps/api/src/modules/process';

const REDIS = `${MODULE}/application/cache-without-tenant.ts`;
const PRISMA_IN_DOMAIN = `${MODULE}/domain/process.ts`;
const RAW_QUERY = `${MODULE}/infrastructure/search-processes.ts`;

describe('[Tenant incorreto] código que contorna o contexto de tenant é barrado (US-077)', async () => {
  const lint = await lintTree(FIXTURES);
  const violations = await cruiseTree(FIXTURES, ['apps']);
  const depcruiseRules = (file: string) =>
    violations.filter((violation) => violation.from === file).map((v) => v.rule.name);
  const lintMessages = (file: string) => lint.get(file) ?? [];

  it('pnpm lint reporta os três arquivos como erro', () => {
    for (const file of [REDIS, PRISMA_IN_DOMAIN, RAW_QUERY]) {
      expect(lintMessages(file).length).toBeGreaterThan(0);
      expect(lintMessages(file).every((message) => message.severity === 2)).toBe(true);
    }
    expect(lintMessages(REDIS)[0]?.ruleId).toBe('contrataflow/no-direct-redis');
    expect(lintMessages(PRISMA_IN_DOMAIN)[0]?.ruleId).toBe(
      'contrataflow/no-prisma-outside-infrastructure',
    );
    expect(lintMessages(RAW_QUERY)[0]?.ruleId).toBe('contrataflow/no-unsafe-raw-query');
  });

  it('pnpm depcruise reporta o Redis direto e o Prisma no domínio', () => {
    expect(depcruiseRules(REDIS)).toContain('redis-only-in-cache-or-platform');
    expect(depcruiseRules(PRISMA_IN_DOMAIN)).toContain('domain-is-pure');
  });

  it('as mensagens orientam TenantCache, repositório e $queryRaw parametrizado', () => {
    expect(lintMessages(REDIS)[0]?.message).toContain('TenantCache');
    expect(lintMessages(PRISMA_IN_DOMAIN)[0]?.message).toContain('repositório');
    expect(lintMessages(RAW_QUERY)[0]?.message).toContain('$queryRaw/$executeRaw parametrizado');
  });
});
