import { describe, expect, it } from 'vitest';

import { RiskTreatmentChanged } from './events.js';
import {
  canChangeTreatmentStatus,
  createRiskTreatmentSchema,
  isTerminalTreatmentStatus,
  nextTreatmentStatuses,
  TREATMENT_MESSAGES,
  updateRiskTreatmentSchema,
} from './treatment.js';

const valid = {
  type: 'PREVENTIVE',
  description: 'Ampliar a divulgação do edital',
};

const messagesOf = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => (result.error?.issues ?? []).map((issue) => [String(issue.path[0]), issue.message]);

describe('RN-RISK-15 — máquina de status do tratamento', () => {
  it('PLANNED → IN_PROGRESS → DONE; não terminais → CANCELED; DONE/CANCELED terminais', () => {
    expect(nextTreatmentStatuses('PLANNED')).toEqual(['IN_PROGRESS', 'CANCELED']);
    expect(nextTreatmentStatuses('IN_PROGRESS')).toEqual(['DONE', 'CANCELED']);
    expect(canChangeTreatmentStatus('PLANNED', 'DONE')).toBe(false);
    expect(canChangeTreatmentStatus('DONE', 'IN_PROGRESS')).toBe(false);
    expect(canChangeTreatmentStatus('CANCELED', 'PLANNED')).toBe(false);
    expect(isTerminalTreatmentStatus('DONE')).toBe(true);
    expect(isTerminalTreatmentStatus('CANCELED')).toBe(true);
    expect(isTerminalTreatmentStatus('IN_PROGRESS')).toBe(false);
    expect(TREATMENT_MESSAGES.invalidTransition('DONE', 'IN_PROGRESS')).toBe(
      'Não é possível mudar o status de Concluída para Em andamento.',
    );
  });
});

describe('createRiskTreatmentSchema (RSK-06 · V-01/V-02)', () => {
  it('aceita o mínimo e normaliza observações vazias para null', () => {
    expect(createRiskTreatmentSchema.parse({ ...valid, notes: '  ' })).toEqual({
      ...valid,
      notes: null,
    });
  });

  it('descrição ausente, curta ou longa; tipo ausente', () => {
    expect(messagesOf(createRiskTreatmentSchema.safeParse({ type: 'PREVENTIVE' }))).toEqual([
      ['description', TREATMENT_MESSAGES.descriptionRequired],
    ]);
    expect(
      messagesOf(createRiskTreatmentSchema.safeParse({ ...valid, description: 'curta' })),
    ).toEqual([['description', TREATMENT_MESSAGES.descriptionLength]]);
    expect(
      messagesOf(createRiskTreatmentSchema.safeParse({ ...valid, description: 'x'.repeat(1001) })),
    ).toEqual([['description', TREATMENT_MESSAGES.descriptionLength]]);
    expect(
      messagesOf(createRiskTreatmentSchema.safeParse({ description: valid.description })),
    ).toEqual([['type', TREATMENT_MESSAGES.typeRequired]]);
  });

  it('prazo no passado é aceito (FA-03); data mal formada e campos do sistema recusados', () => {
    expect(createRiskTreatmentSchema.safeParse({ ...valid, dueDate: '2020-01-01' }).success).toBe(
      true,
    );
    expect(
      messagesOf(createRiskTreatmentSchema.safeParse({ ...valid, dueDate: '01/01/2020' })),
    ).toEqual([['dueDate', TREATMENT_MESSAGES.dueDateInvalid]]);
    expect(createRiskTreatmentSchema.safeParse({ ...valid, status: 'DONE' }).success).toBe(false);
    expect(createRiskTreatmentSchema.safeParse({ ...valid, sortOrder: 1 }).success).toBe(false);
  });
});

describe('updateRiskTreatmentSchema (RSK-07)', () => {
  it('parcial, com status e sortOrder; completedAt é do sistema', () => {
    expect(
      updateRiskTreatmentSchema.parse({ status: 'DONE', sortOrder: 2, dueDate: null }),
    ).toEqual({ status: 'DONE', sortOrder: 2, dueDate: null });
    expect(
      updateRiskTreatmentSchema.safeParse({ completedAt: '2026-10-18T00:00:00Z' }).success,
    ).toBe(false);
    expect(updateRiskTreatmentSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
    expect(updateRiskTreatmentSchema.safeParse({ status: 'REOPENED' }).success).toBe(false);
  });
});

describe('RiskTreatmentChanged (events.md)', () => {
  it('payload só com ids, change e status', () => {
    const payload = {
      riskId: '0192d034-0000-7000-8000-000000000001',
      treatmentId: '0192d034-0000-7000-8000-000000000002',
      change: 'STATUS_CHANGED',
      status: 'DONE',
    } as const;
    const draft = RiskTreatmentChanged.of({ aggregateId: payload.riskId, payload });
    expect(draft.definition.eventType).toBe('RiskTreatmentChanged');
    expect(RiskTreatmentChanged.payloadSchema.safeParse(payload).success).toBe(true);
    expect(
      RiskTreatmentChanged.payloadSchema.safeParse({ ...payload, description: 'x' }).success,
    ).toBe(false);
  });
});
