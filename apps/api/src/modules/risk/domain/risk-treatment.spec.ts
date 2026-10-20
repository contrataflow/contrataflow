import type { CreateRiskTreatment, TreatmentStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  changeTreatmentStatus,
  createRiskTreatment,
  diffRiskTreatment,
  nextTreatmentSortOrder,
  patchRiskTreatment,
  touchRiskTreatment,
} from './risk-treatment.js';
import type { RiskTreatment } from './risk-treatment.js';
import { startTreatment } from './risk.js';
import type { Risk } from './risk.js';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const LATER = new Date('2026-10-20T09:30:00.000Z');
const RISK = {
  id: '0192d034-0000-7000-8000-000000000001',
  tenantId: '0192d034-0000-7000-8000-00000000000a',
  processId: '0192d034-0000-7000-8000-0000000000b1',
};
const USER = '0192d034-0000-7000-8000-0000000000c1';

const body: CreateRiskTreatment = {
  type: 'PREVENTIVE',
  description: 'Ampliar a divulgação do edital',
  responsibleId: USER,
  responsibleDepartmentId: null,
  dueDate: '2026-11-30',
  notes: null,
};

function treatment(fields: Partial<RiskTreatment> = {}): RiskTreatment {
  return {
    ...createRiskTreatment(body, {
      id: '0192d034-0000-7000-8000-0000000000d1',
      risk: RISK,
      sortOrder: 0,
      now: NOW,
      userId: USER,
    }),
    ...fields,
  };
}

describe('RiskTreatment.create (RN-RISK-11/13)', () => {
  it('nasce PLANNED, sem completedAt, com risco, processo, tenant e posição do contexto', () => {
    const created = createRiskTreatment(
      { type: 'CONTINGENCY', description: 'Contratação emergencial' },
      { id: 'id-1', risk: RISK, sortOrder: 3, now: NOW, userId: null },
    );
    expect(created).toMatchObject({
      id: 'id-1',
      tenantId: RISK.tenantId,
      riskId: RISK.id,
      processId: RISK.processId,
      type: 'CONTINGENCY',
      status: 'PLANNED',
      completedAt: null,
      // RN-RISK-13: responsável e unidade opcionais.
      responsibleId: null,
      responsibleDepartmentId: null,
      dueDate: null,
      notes: null,
      sortOrder: 3,
      createdAt: NOW,
      version: 1,
      deletedAt: null,
    });
  });

  it('posição ao fim da lista do risco (FA-02)', () => {
    expect(nextTreatmentSortOrder([])).toBe(0);
    expect(nextTreatmentSortOrder([{ sortOrder: 0 }, { sortOrder: 4 }, { sortOrder: 2 }])).toBe(5);
  });
});

describe('RiskTreatment.changeStatus (RN-RISK-12/15)', () => {
  const allowed: [TreatmentStatus, TreatmentStatus][] = [
    ['PLANNED', 'IN_PROGRESS'],
    ['PLANNED', 'CANCELED'],
    ['IN_PROGRESS', 'DONE'],
    ['IN_PROGRESS', 'CANCELED'],
  ];
  it.each(allowed)('%s → %s é permitido', (from, to) => {
    const result = changeTreatmentStatus(treatment({ status: from }), to, LATER);
    expect(result).toMatchObject({ ok: true, statusChange: { from, to } });
  });

  const refused: [TreatmentStatus, TreatmentStatus][] = [
    ['PLANNED', 'DONE'],
    ['IN_PROGRESS', 'PLANNED'],
    ['DONE', 'IN_PROGRESS'],
    ['DONE', 'CANCELED'],
    ['CANCELED', 'PLANNED'],
    ['CANCELED', 'IN_PROGRESS'],
  ];
  it.each(refused)('%s → %s é recusado (terminal ou fora da sequência)', (from, to) => {
    expect(changeTreatmentStatus(treatment({ status: from }), to, LATER)).toEqual({
      ok: false,
      refused: { from, to },
    });
  });

  it('DONE preenche completedAt com agora; o mesmo status não é mudança', () => {
    const done = changeTreatmentStatus(treatment({ status: 'IN_PROGRESS' }), 'DONE', LATER);
    expect(done.ok && done.next).toMatchObject({ status: 'DONE', completedAt: LATER });
    const same = changeTreatmentStatus(
      treatment({ status: 'DONE', completedAt: NOW }),
      'DONE',
      LATER,
    );
    expect(same).toMatchObject({ ok: true, statusChange: null, next: { completedAt: NOW } });
  });

  it('sair de DONE limparia completedAt (qualquer status ≠ DONE grava null)', () => {
    const canceled = changeTreatmentStatus(
      treatment({ status: 'PLANNED', completedAt: NOW }),
      'CANCELED',
      LATER,
    );
    expect(canceled.ok && canceled.next.completedAt).toBeNull();
  });
});

describe('patchRiskTreatment + diff (RSK-07)', () => {
  it('campos enviados mudam, `null` limpa, ausentes mantêm; diff na ordem canônica', () => {
    const before = treatment({ notes: 'Observação' });
    const result = patchRiskTreatment(
      before,
      { description: 'Publicar o edital em três jornais', notes: null, responsibleId: null },
      LATER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statusChange).toBeNull();
    expect(result.next).toMatchObject({
      type: 'PREVENTIVE',
      dueDate: '2026-11-30',
      responsibleId: null,
      notes: null,
    });
    expect(diffRiskTreatment(before, result.next).map((change) => change.field)).toEqual([
      'description',
      'responsibleId',
      'notes',
    ]);
  });

  it('status junto com edição: aplica a máquina de status sobre o estado editado', () => {
    const result = patchRiskTreatment(
      treatment({ status: 'IN_PROGRESS' }),
      { status: 'DONE', dueDate: null, sortOrder: 2 },
      LATER,
    );
    expect(result).toMatchObject({
      ok: true,
      statusChange: { from: 'IN_PROGRESS', to: 'DONE' },
      next: { status: 'DONE', completedAt: LATER, dueDate: null, sortOrder: 2 },
    });
    expect(patchRiskTreatment(treatment({ status: 'DONE' }), { status: 'PLANNED' }, LATER)).toEqual(
      { ok: false, refused: { from: 'DONE', to: 'PLANNED' } },
    );
  });

  it('criação: diff com todos os campos definidos; touch grava autoria e data', () => {
    const created = treatment();
    expect(diffRiskTreatment(null, created).map((change) => change.field)).toEqual([
      'type',
      'description',
      'responsibleId',
      'dueDate',
      'status',
      'sortOrder',
    ]);
    expect(touchRiskTreatment(created, LATER, 'outro')).toMatchObject({
      updatedAt: LATER,
      updatedById: 'outro',
      version: 1,
    });
  });
});

describe('Risk.startTreatment (RN-RISK-14)', () => {
  const risk = { status: 'OPEN' } as Risk;

  it('primeiro tratamento ativo de um risco OPEN → IN_TREATMENT', () => {
    expect(startTreatment(risk, [])?.status).toBe('IN_TREATMENT');
    // Só havia tratamentos cancelados: o novo é o primeiro ativo.
    expect(startTreatment(risk, [{ status: 'CANCELED' }])?.status).toBe('IN_TREATMENT');
  });

  it('não muda o risco já em outro status nem com tratamento ativo existente', () => {
    expect(startTreatment({ status: 'MITIGATED' } as Risk, [])).toBeNull();
    expect(startTreatment({ status: 'IN_TREATMENT' } as Risk, [])).toBeNull();
    expect(startTreatment(risk, [{ status: 'DONE' }])).toBeNull();
  });
});
