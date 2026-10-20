import { describe, expect, it } from 'vitest';

import { decideRetirement } from './workflow-version-lifecycle.js';

/* RN-WF-66 · V-03/V-04 (US-045): decisão pura de aposentar uma versão pelo WF-22. */

const v1 = { id: 'v1', status: 'PUBLISHED', versionNumber: 1 } as const;
const v2 = { id: 'v2', status: 'PUBLISHED', versionNumber: 2 } as const;
const v3 = { id: 'v3', status: 'PUBLISHED', versionNumber: 3 } as const;
const draft = { id: 'v4', status: 'DRAFT', versionNumber: 4 } as const;
const retired = { id: 'v0', status: 'RETIRED', versionNumber: 0 } as const;

const active = { isActive: true, isDefault: false, currentPublishedVersionId: 'v2' };

describe('decideRetirement (RN-WF-66)', () => {
  it('rascunho ou já aposentada → INVALID_STATE', () => {
    expect(decideRetirement(active, draft, [draft, v2])).toEqual({ kind: 'INVALID_STATE' });
    expect(decideRetirement(active, retired, [retired, v2])).toEqual({ kind: 'INVALID_STATE' });
  });

  it('publicada que não é a corrente → aposenta sem mexer na corrente', () => {
    expect(decideRetirement(active, v1, [v1, v2])).toEqual({
      kind: 'RETIRE',
      nextCurrentVersionId: undefined,
    });
  });

  it('corrente com outra publicada → a de maior número assume', () => {
    expect(decideRetirement(active, v2, [v1, v3, v2, draft])).toEqual({
      kind: 'RETIRE',
      nextCurrentVersionId: 'v3',
    });
  });

  it('corrente única de workflow ativo → IN_USE (FA-03)', () => {
    expect(decideRetirement(active, v2, [retired, v2, draft])).toEqual({ kind: 'IN_USE' });
  });

  it('corrente única de workflow padrão (mesmo inativo) → IN_USE (RN-WF-41)', () => {
    expect(decideRetirement({ ...active, isActive: false, isDefault: true }, v2, [v2])).toEqual({
      kind: 'IN_USE',
    });
  });

  it('corrente única de workflow inativo e não padrão → fica sem publicada (FA-04)', () => {
    expect(decideRetirement({ ...active, isActive: false }, v2, [v2])).toEqual({
      kind: 'RETIRE',
      nextCurrentVersionId: null,
    });
  });
});
