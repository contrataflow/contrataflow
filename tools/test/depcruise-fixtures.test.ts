import { fileURLToPath } from 'node:url';

import type { IViolation } from 'dependency-cruiser';
import { beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../lib/workspace.js';
import { cruiseTree, loadDepcruiseConfig } from './support/analyzers.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/depcruise/', import.meta.url));

/** Uma fixture por regra do .dependency-cruiser.cjs (RN-FND-05). */
const EXPECTED: Record<string, string> = {
  'apps/api/src/modules/process/domain/process.aggregate.ts': 'domain-is-pure',
  'apps/api/src/modules/process/domain/uses-application.ts': 'domain-is-pure',
  'apps/api/src/modules/dfd/application/reads-process-internals.ts': 'cross-module-only-via-facade',
  'apps/api/src/modules/workflow/application/uses-process-facade.ts': 'module-levels',
  'apps/api/src/modules/ai/application/runs-document-command.ts': 'ai-read-only',
  'apps/api/src/modules/catalog/application/cycle-a.ts': 'no-circular',
  'apps/api/src/shared/uses-module.ts': 'shared-kernel-is-independent',
  'apps/api/src/modules/process/application/uses-redis.ts': 'redis-only-in-cache-or-platform',
  'apps/api/src/modules/process/infrastructure/uses-system-prisma.ts': 'system-prisma-allowlist',
  'apps/api/src/modules/process/infrastructure/uses-platform-transaction.ts':
    'platform-transaction-allowlist',
  'apps/worker/src/processors/loads-controller.ts': 'worker-never-loads-presentation',
  'apps/worker/src/processors/loads-api-main.ts': 'worker-only-api-allowed-paths',
  'apps/web/src/app/imports-api.ts': 'web-never-imports-api',
  'apps/api/src/imports-ui.ts': 'api-never-imports-ui-web-worker',
  'apps/worker/src/imports-web.ts': 'worker-never-imports-ui-web',
  'packages/types/src/imports-validation.ts': 'types-imports-nothing-internal',
  'packages/validation/src/imports-editor.ts': 'validation-only-types',
  'packages/editor/src/imports-ui.ts': 'editor-only-types-validation',
  'packages/ui/src/imports-validation.ts': 'ui-only-types',
  'packages/observability/src/imports-validation.ts': 'observability-only-types',
  'apps/api/src/modules/process/application/imports-missing.ts': 'not-to-unresolvable',
};

/** Usos legítimos que não podem ser reprovados. */
const ALLOWED = [
  'apps/api/src/modules/dfd/application/dfd.facade.ts',
  'apps/api/src/modules/ai/application/reads-document-facade.ts',
  'apps/api/src/modules/identity/infrastructure/prisma-identity.repository.ts',
  'apps/worker/src/outbox/relay.ts',
  'packages/validation/src/index.ts',
  'packages/editor/src/index.ts',
  'packages/ui/src/index.ts',
  'packages/observability/src/index.ts',
];

describe('fixtures do dependency-cruiser (RN-FND-05)', () => {
  let violations: IViolation[];

  beforeAll(async () => {
    violations = await cruiseTree(FIXTURES, ['apps', 'packages']);
  });

  const rulesOf = (file: string) =>
    new Set(violations.filter((violation) => violation.from === file).map((v) => v.rule.name));

  it.each(Object.entries(EXPECTED))('%s viola %s', (file, rule) => {
    expect(rulesOf(file)).toContain(rule);
    for (const violation of violations.filter((v) => v.from === file)) {
      expect(violation.rule.severity).toBe('error');
    }
  });

  it.each(ALLOWED)('%s é permitido', (file) => {
    expect([...rulesOf(file)]).toEqual([]);
  });

  it('toda regra configurada tem fixture de violação', () => {
    const configured = new Set(loadDepcruiseConfig().forbidden.map((rule) => rule.name));
    expect([...configured].sort()).toEqual([...new Set(Object.values(EXPECTED))].sort());
  });

  // O cruzeiro do repositório inteiro cresce a cada story (~130 s no Windows dentro da suíte de
  // `tools`, em 2026-10-19): limite próprio, acima do `testTimeout` padrão de 120 s.
  it('o repositório real não tem violações', async () => {
    const real = await cruiseTree(REPO_ROOT, ['apps', 'packages']);
    expect(real.map((v) => `${v.rule.name}: ${v.from} → ${v.to}`)).toEqual([]);
  }, 300_000);
});
