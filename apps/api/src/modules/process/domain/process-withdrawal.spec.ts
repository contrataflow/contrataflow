import { describe, expect, it } from 'vitest';

import { hasPreviousCustody, originPassOf } from './process-withdrawal.js';

const pass = (id: string, sequence: number, status: string, departmentId = 'dep-term') => ({
  id,
  sequence,
  status,
  workflowStageId: `stage-${id}`,
  departmentId,
});

describe('originPassOf (US-053 · RN-TRAM-68)', () => {
  const stages = [
    pass('opening', 1, 'COMPLETED', 'dep-opening'),
    pass('term', 2, 'COMPLETED'),
    pass('approval', 3, 'ACTIVE', 'dep-approval'),
  ];

  it('a passagem anterior à aprovação ativa é a de origem', () => {
    expect(originPassOf(stages, 'approval')?.id).toBe('term');
  });

  it('passagem não ativa ou sem anterior: null', () => {
    expect(originPassOf(stages, 'term')).toBeNull();
    expect(originPassOf([pass('approval', 1, 'ACTIVE')], 'approval')).toBeNull();
    expect(originPassOf(stages, null)).toBeNull();
  });
});

describe('hasPreviousCustody (POL-17 · RN-TRAM-64)', () => {
  const base = {
    userId: 'ana',
    requestedById: 'ana',
    originDepartmentId: 'dep-term',
    viewerDepartmentIds: [] as string[],
  };

  it('o solicitante tem custódia anterior', () => {
    expect(hasPreviousCustody(base)).toBe(true);
  });

  it('quem está lotado na unidade de origem também', () => {
    expect(
      hasPreviousCustody({ ...base, userId: 'colega', viewerDepartmentIds: ['dep-term'] }),
    ).toBe(true);
  });

  it('nem solicitante nem lotado na origem: sem custódia', () => {
    expect(
      hasPreviousCustody({ ...base, userId: 'bruno', viewerDepartmentIds: ['dep-saude'] }),
    ).toBe(false);
  });
});
