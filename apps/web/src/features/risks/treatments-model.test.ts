import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { ID } from '@test/support/process-fixtures';
import { treatmentFixture } from '@test/support/risk-fixtures';

import {
  createTreatmentBodyOf,
  dueStateOf,
  formatDueDate,
  localToday,
  reorderPatches,
  statusOptionsOf,
  treatmentFormValuesOf,
  treatmentPatchOf,
  treatmentProblemMessage,
  treatmentProblemOf,
  validateTreatment,
} from './treatments-model';

const RISK_ID = ID(901);

describe('formulário ↔ corpos de RSK-06/07', () => {
  it('novo: vazios = não informados; edição: só o que mudou (null limpa)', () => {
    const empty = treatmentFormValuesOf(null);
    expect(createTreatmentBodyOf(empty)).toEqual({ description: '' });
    expect(
      createTreatmentBodyOf({
        ...empty,
        type: 'PREVENTIVE',
        description: 'Ampliar a divulgação',
        responsibleId: ID(1),
        dueDate: '2026-11-30',
        notes: '  ',
      }),
    ).toEqual({
      type: 'PREVENTIVE',
      description: 'Ampliar a divulgação',
      responsibleId: ID(1),
      dueDate: '2026-11-30',
    });

    const treatment = treatmentFixture(1, RISK_ID, {
      responsibleId: ID(1),
      responsible: { id: ID(1), name: 'Ana Souza' },
      dueDate: '2026-11-30',
    });
    const values = treatmentFormValuesOf(treatment);
    expect(values).toMatchObject({ responsibleName: 'Ana Souza', dueDate: '2026-11-30' });
    expect(treatmentPatchOf(treatment, values)).toEqual({});
    expect(
      treatmentPatchOf(treatment, {
        ...values,
        description: ` ${treatment.description} `,
        responsibleId: '',
        dueDate: '',
        notes: 'Nova',
        type: 'CONTINGENCY',
      }),
    ).toEqual({ type: 'CONTINGENCY', responsibleId: null, dueDate: null, notes: 'Nova' });
  });

  it('validação com o schema da API', () => {
    expect(validateTreatment(treatmentFormValuesOf(null))).toEqual({
      type: 'Informe o tipo.',
      description: 'Informe a descrição.',
    });
    expect(
      validateTreatment({
        ...treatmentFormValuesOf(null),
        type: 'PREVENTIVE',
        description: 'Ampliar a divulgação',
        notes: 'x'.repeat(1001),
      }),
    ).toEqual({ notes: 'As observações devem ter no máximo 1.000 caracteres.' });
  });
});

describe('erros da API (Casos de erro)', () => {
  const error = (
    status: number,
    code: string,
    extra: Omit<ConstructorParameters<typeof ApiError>[0], 'status' | 'code'> = {},
  ) => new ApiError({ status, code, ...extra });

  it('classifica 412, 409, 403, 422, 404, 503 e o inesperado', () => {
    expect(treatmentProblemOf(error(412, 'VERSION_CONFLICT'))).toEqual({ kind: 'stale' });
    expect(
      treatmentProblemOf(error(409, 'INVALID_STATE', { detail: 'Não é possível…' })),
    ).toMatchObject({ kind: 'invalidState', message: 'Não é possível…' });
    expect(treatmentProblemOf(error(409, 'DOCUMENT_NOT_EDITABLE'))).toEqual({
      kind: 'blocked',
      message: 'As ações de tratamento estão bloqueadas porque o Mapa de Riscos foi concluído.',
    });
    expect(treatmentProblemOf(error(403, 'PERMISSION_DENIED'))).toEqual({ kind: 'permission' });
    expect(
      treatmentProblemOf(
        error(422, 'VALIDATION_ERROR', {
          errors: [
            { field: 'responsibleId', code: 'REFERENCE_NOT_FOUND', message: 'x' },
            { field: 'description', code: 'TOO_SHORT', message: 'Curta.' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'fields',
      fields: { responsibleId: 'Selecione um responsável válido.', description: 'Curta.' },
    });
    expect(treatmentProblemOf(error(422, 'IDEMPOTENCY_KEY_REUSED'))).toEqual({
      kind: 'keyReused',
    });
    expect(treatmentProblemOf(error(404, 'NOT_FOUND'))).toEqual({ kind: 'notFound' });
    expect(treatmentProblemOf(error(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
    });
    expect(treatmentProblemOf(error(500, 'INTERNAL_ERROR', { correlationId: 'c-1' }))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(treatmentProblemOf(new Error('x'))).toEqual({ kind: 'unexpected', correlationId: '—' });
    expect(treatmentProblemMessage({ kind: 'stale' })).toBe(
      'Esta ação foi alterada por outra pessoa. Recarregue para ver a versão atual.',
    );
    expect(treatmentProblemMessage({ kind: 'keyReused' })).toBeNull();
  });
});

describe('status (RN-RISK-15) e prazo (FA-03)', () => {
  it('opções: o atual e os próximos permitidos', () => {
    expect(statusOptionsOf('PLANNED')).toEqual(['PLANNED', 'IN_PROGRESS', 'CANCELED']);
    expect(statusOptionsOf('IN_PROGRESS')).toEqual(['IN_PROGRESS', 'DONE', 'CANCELED']);
    expect(statusOptionsOf('DONE')).toEqual(['DONE']);
  });

  it('"Atrasado" só com prazo vencido e status não terminal; "Vence hoje/em N dias" na semana', () => {
    const today = '2026-10-18';
    const due = (dueDate: string | null, status = 'PLANNED' as const) => ({ dueDate, status });
    expect(dueStateOf(due('2026-10-17'), today)).toEqual({ kind: 'overdue', days: 1 });
    expect(dueStateOf(due('2026-10-18'), today)).toEqual({ kind: 'today' });
    expect(dueStateOf(due('2026-10-23'), today)).toEqual({ kind: 'soon', days: 5 });
    expect(dueStateOf(due('2026-10-26'), today)).toBeNull();
    expect(dueStateOf(due(null), today)).toBeNull();
    expect(dueStateOf({ dueDate: '2026-10-01', status: 'DONE' }, today)).toBeNull();
    expect(dueStateOf({ dueDate: '2026-10-01', status: 'CANCELED' }, today)).toBeNull();
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(formatDueDate('2026-11-30')).toBe('30/11/2026');
  });
});

describe('reordenação (FA-02)', () => {
  it('PATCH só dos itens cuja posição muda', () => {
    const items = [
      treatmentFixture(1, RISK_ID, { sortOrder: 0 }),
      treatmentFixture(2, RISK_ID, { sortOrder: 1, version: 2 }),
      treatmentFixture(3, RISK_ID, { sortOrder: 2 }),
    ];
    expect(reorderPatches(items, 2, 1)).toEqual([
      { id: items[2]?.id, version: 1, sortOrder: 1 },
      { id: items[1]?.id, version: 2, sortOrder: 2 },
    ]);
    expect(reorderPatches(items, 0, -1)).toEqual([]);
    expect(reorderPatches(items, 1, 1)).toEqual([]);
    // Posições iguais (tratamentos antigos com sortOrder 0): normaliza 0..n-1.
    const legacy = items.map((item) => ({ ...item, sortOrder: 0 }));
    expect(reorderPatches(legacy, 0, 1).map((patch) => patch.sortOrder)).toEqual([1, 2]);
  });
});
