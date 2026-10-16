import { describe, expect, it } from 'vitest';

import { canViewProcess } from './process-visibility.js';
import type { ProcessViewer } from './process-visibility.js';

/* US-041/US-097 — DEC-024: visibilidade que autoriza PRC-08/PRC-09 (não visível = 404). */

const ACCESS = { departmentIds: ['setor', 'compras'], userIds: ['criador'] };

const viewer = (overrides: Partial<ProcessViewer> = {}): ProcessViewer => ({
  userId: 'ana',
  tenantWide: false,
  organizationIds: [],
  departmentIds: [],
  ...overrides,
});

describe('canViewProcess (DEC-024)', () => {
  it.each([
    ['PROCESS_VIEW em todo o tenant', viewer({ tenantWide: true }), true],
    ['PROCESS_VIEW por unidade com acesso', viewer({ departmentIds: ['compras'] }), true],
    ['PROCESS_VIEW por unidade sem acesso', viewer({ departmentIds: ['juridico'] }), false],
    ['PROCESS_VIEW no órgão do processo', viewer({ organizationIds: ['org-a'] }), true],
    ['PROCESS_VIEW em outro órgão', viewer({ organizationIds: ['org-b'] }), false],
    ['concessão própria sem PROCESS_VIEW', viewer({ userId: 'criador' }), true],
    ['sem PROCESS_VIEW em escopo algum', viewer(), false],
  ])('%s → %s', (_case, candidate, expected) => {
    expect(canViewProcess(ACCESS, candidate, 'org-a')).toBe(expected);
  });

  it('processo sem órgão conhecido não é coberto por escopo de órgão', () => {
    expect(canViewProcess(ACCESS, viewer({ organizationIds: ['org-a'] }))).toBe(false);
  });
});
