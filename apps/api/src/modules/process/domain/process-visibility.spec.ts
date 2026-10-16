import { describe, expect, it } from 'vitest';

import { canViewProcess } from './process-visibility.js';
import type { ProcessViewer } from './process-visibility.js';

/* US-041 — DEC-024: visibilidade que autoriza PRC-08/PRC-09 (não visível = 404). */

const ACCESS = { departmentIds: ['setor', 'compras'], userIds: ['criador'] };

const viewer = (overrides: Partial<ProcessViewer> = {}): ProcessViewer => ({
  userId: 'ana',
  hasProcessView: true,
  viewsWholeTenant: false,
  departmentIds: [],
  ...overrides,
});

describe('canViewProcess (DEC-024)', () => {
  it.each([
    ['PROCESS_VIEW em todo o tenant', viewer({ viewsWholeTenant: true }), true],
    ['PROCESS_VIEW por unidade lotada com acesso', viewer({ departmentIds: ['compras'] }), true],
    ['PROCESS_VIEW por unidade sem acesso', viewer({ departmentIds: ['juridico'] }), false],
    [
      'concessão própria sem PROCESS_VIEW',
      viewer({ userId: 'criador', hasProcessView: false }),
      true,
    ],
    [
      'sem PROCESS_VIEW, mesmo lotado em unidade com acesso',
      viewer({ hasProcessView: false, viewsWholeTenant: true, departmentIds: ['setor'] }),
      false,
    ],
  ])('%s → %s', (_case, candidate, expected) => {
    expect(canViewProcess(ACCESS, candidate)).toBe(expected);
  });
});
