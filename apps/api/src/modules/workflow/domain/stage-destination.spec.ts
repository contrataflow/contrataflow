import { describe, expect, it } from 'vitest';

import type { StagePassFact } from './rule-facts.js';
import {
  previousAssigneeOf,
  resolveStageAssignee,
  resolveStageDepartment,
} from './stage-destination.js';
import type { DestinationStage } from './stage-destination.js';

/* US-041 — RN-WF-30 (unidade) e RN-WF-31 (responsável inicial) da etapa alcançada. */

const UNITS = { requestingDepartmentId: 'setor', requestingSecretariatId: 'secretaria' };

const stage = (overrides: Partial<DestinationStage> = {}): DestinationStage => ({
  id: 'etapa-tr',
  departmentResolution: 'REQUESTING_DEPARTMENT',
  fixedDepartmentId: null,
  assignmentPolicy: 'UNASSIGNED',
  ...overrides,
});

const pass = (overrides: Partial<StagePassFact>): StagePassFact => ({
  processStageId: 'p',
  workflowStageId: 'etapa-tr',
  sequence: 1,
  status: 'COMPLETED',
  departmentId: 'setor',
  assigneeId: null,
  enteredAt: '2026-10-01T12:00:00.000Z',
  exitedAt: null,
  ...overrides,
});

describe('RN-WF-30 — DepartmentResolution', () => {
  it('FIXED usa a unidade fixa da etapa', () => {
    expect(
      resolveStageDepartment(
        stage({ departmentResolution: 'FIXED', fixedDepartmentId: 'compras' }),
        UNITS,
      ),
    ).toEqual({ mode: 'FIXED', departmentId: 'compras' });
  });

  it('REQUESTING_DEPARTMENT e REQUESTING_SECRETARIAT usam os campos do processo', () => {
    expect(resolveStageDepartment(stage(), UNITS)).toEqual({
      mode: 'REQUESTING_DEPARTMENT',
      departmentId: 'setor',
    });
    expect(
      resolveStageDepartment(stage({ departmentResolution: 'REQUESTING_SECRETARIAT' }), UNITS),
    ).toEqual({ mode: 'REQUESTING_SECRETARIAT', departmentId: 'secretaria' });
  });

  it('CHOSEN_ON_FORWARD usa a unidade do comando (em aberto sem ela)', () => {
    const chosen = stage({ departmentResolution: 'CHOSEN_ON_FORWARD' });
    expect(resolveStageDepartment(chosen, UNITS)).toEqual({
      mode: 'CHOSEN_ON_FORWARD',
      departmentId: null,
    });
    expect(resolveStageDepartment(chosen, UNITS, 'juridico')).toEqual({
      mode: 'CHOSEN_ON_FORWARD',
      departmentId: 'juridico',
    });
  });
});

describe('RN-WF-31 — StageAssignmentPolicy', () => {
  const passes = [
    pass({ sequence: 4, assigneeId: 'pedro' }),
    pass({ sequence: 2, assigneeId: 'joana' }),
    pass({ sequence: 6, assigneeId: null }),
    pass({ sequence: 7, workflowStageId: 'outra', assigneeId: 'zeca' }),
  ];
  const candidates = { creatorId: 'criador', departmentHeadId: 'titular', passes };

  it.each([
    ['UNASSIGNED', null],
    ['CREATOR', 'criador'],
    ['DEPARTMENT_HEAD', 'titular'],
    ['PREVIOUS_ASSIGNEE', 'pedro'],
  ] as const)('%s → %s', (assignmentPolicy, expected) => {
    expect(resolveStageAssignee(stage({ assignmentPolicy }), candidates)).toBe(expected);
  });

  it('PREVIOUS_ASSIGNEE sem passagem anterior com responsável = fila da unidade', () => {
    expect(previousAssigneeOf([pass({ assigneeId: null })], 'etapa-tr')).toBeNull();
    expect(
      resolveStageAssignee(stage({ assignmentPolicy: 'PREVIOUS_ASSIGNEE' }), {
        ...candidates,
        passes: [],
      }),
    ).toBeNull();
  });

  it('DEPARTMENT_HEAD sem titular = fila da unidade', () => {
    expect(
      resolveStageAssignee(stage({ assignmentPolicy: 'DEPARTMENT_HEAD' }), {
        ...candidates,
        departmentHeadId: null,
      }),
    ).toBeNull();
  });
});
