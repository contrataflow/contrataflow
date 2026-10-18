import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { returnEntry, secondReturnEntry, STAGE_ABERTURA } from '@test/support/return-fixtures';

import {
  buildReturnBody,
  describeReturnError,
  initialTargetId,
  returnTargets,
  validateReturn,
} from './return-model';

/* US-048 · SCR-104 — regras puras do diálogo "Devolver processo". */

const TODAY = '2026-10-05';
const REASON = 'Faltou detalhar a justificativa da contratação no DFD';

const apiError = (
  status: number,
  code: string,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ status, code, correlationId: 'c-1', ...extra });

describe('return-model (US-048)', () => {
  it('returnTargets: só RETURN habilitadas com etapa, uma por etapa, com nome e última passagem', () => {
    const targets = returnTargets([
      returnEntry(),
      returnEntry({ transitionKey: 'DUPLICADA' }),
      secondReturnEntry({ enabled: false }),
      { action: 'CLAIM', label: 'Assumir', enabled: true, reasons: [] },
      returnEntry({ toStageId: undefined, transitionKey: 'SEM_ETAPA' }),
    ]);
    expect(targets).toEqual([
      {
        stageId: STAGE_ABERTURA,
        stageName: 'Formalização da demanda',
        lastPassedAt: '2026-09-30T15:00:00.000Z',
        allowDueDateOverride: true,
      },
    ]);
    expect(returnTargets(undefined)).toEqual([]);
    expect(
      returnTargets([returnEntry({ toStageName: undefined, lastPassedAt: undefined })])[0],
    ).toMatchObject({ stageName: 'Devolver à formalização da demanda', lastPassedAt: null });
  });

  it('initialTargetId: a etapa da ação escolhida; FA-03 — única opção pré-selecionada', () => {
    const one = returnTargets([returnEntry()]);
    const two = returnTargets([returnEntry(), secondReturnEntry()]);
    expect(initialTargetId(one, null)).toBe(STAGE_ABERTURA);
    expect(initialTargetId(two, null)).toBeNull();
    expect(initialTargetId(two, two[1]?.stageId)).toBe(two[1]?.stageId);
    expect(initialTargetId(two, 'outra-etapa')).toBeNull();
  });

  it('validateReturn: destino e motivo obrigatórios, motivo 10–5.000 e prazo entre hoje e +365', () => {
    const [target] = returnTargets([returnEntry()]);
    expect(validateReturn({ target: undefined, comment: '', dueAt: '' }, TODAY)).toEqual({
      targetStageId: 'Informe a etapa de destino.',
      comment: 'Informe o motivo da devolução.',
    });
    expect(validateReturn({ target, comment: 'Corrigir', dueAt: '' }, TODAY)).toEqual({
      comment: 'O motivo deve ter ao menos 10 caracteres.',
    });
    expect(validateReturn({ target, comment: 'x'.repeat(5001), dueAt: '' }, TODAY)).toEqual({
      comment: 'O motivo pode ter até 5.000 caracteres.',
    });
    expect(validateReturn({ target, comment: REASON, dueAt: '2026-10-04' }, TODAY)).toEqual({
      dueAt: 'Informe uma data de prazo entre hoje e os próximos 365 dias.',
    });
    expect(validateReturn({ target, comment: REASON, dueAt: '2027-10-06' }, TODAY)).toHaveProperty(
      'dueAt',
    );
    expect(validateReturn({ target, comment: REASON, dueAt: '2027-10-05' }, TODAY)).toEqual({});
    // FA-02: sem sobrescrita permitida, o prazo não é validado (o campo nem aparece).
    const [locked] = returnTargets([secondReturnEntry()]);
    expect(validateReturn({ target: locked, comment: REASON, dueAt: '2020-01-01' }, TODAY)).toEqual(
      {},
    );
  });

  it('buildReturnBody: motivo aparado, etapa esperada e prazo só quando permitido e informado', () => {
    const [target] = returnTargets([returnEntry()]);
    const [locked] = returnTargets([secondReturnEntry()]);
    if (!target || !locked) throw new Error('destinos ausentes');
    expect(buildReturnBody({ target, comment: `  ${REASON} `, dueAt: '' }, 'stage-1')).toEqual({
      targetStageId: STAGE_ABERTURA,
      comment: REASON,
      expectedStageId: 'stage-1',
    });
    expect(buildReturnBody({ target, comment: REASON, dueAt: '2026-10-30' }, 's')).toHaveProperty(
      'dueAt',
      '2026-10-30',
    );
    expect(
      buildReturnBody({ target: locked, comment: REASON, dueAt: '2026-10-30' }, 's'),
    ).not.toHaveProperty('dueAt');
  });

  it('describeReturnError: cada caso de erro da story', () => {
    expect(describeReturnError(apiError(409, 'STAGE_CHANGED'))).toEqual({
      kind: 'stale',
      code: 'STAGE_CHANGED',
    });
    expect(describeReturnError(apiError(412, 'VERSION_CONFLICT'))).toEqual({
      kind: 'stale',
      code: 'VERSION_CONFLICT',
    });
    expect(describeReturnError(apiError(428, 'PRECONDITION_REQUIRED')).kind).toBe('precondition');
    expect(describeReturnError(apiError(409, 'INVALID_PROCESS_STATUS')).kind).toBe('status');
    expect(describeReturnError(apiError(403, 'NOT_PROCESS_CUSTODIAN')).kind).toBe('custody');
    expect(describeReturnError(apiError(404, 'PROCESS_NOT_FOUND')).kind).toBe('notFound');
    expect(describeReturnError(apiError(422, 'TRANSITION_NOT_AVAILABLE')).kind).toBe(
      'targetNotAvailable',
    );
    expect(describeReturnError(apiError(422, 'DUE_DATE_OVERRIDE_NOT_ALLOWED')).kind).toBe(
      'dueNotAllowed',
    );
    expect(
      describeReturnError(
        apiError(422, 'VALIDATION_ERROR', {
          errors: [
            { field: 'comment', code: 'TOO_SHORT', message: 'Curto.' },
            { field: 'comment', code: 'TOO_SHORT', message: 'Repetido.' },
            { field: 'outro', code: 'NOT_ALLOWED', message: 'Campo não permitido.' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'fields',
      messages: { comment: 'Curto.' },
      others: ['Campo não permitido.'],
    });
    expect(describeReturnError(apiError(503, 'DEPENDENCY_UNAVAILABLE')).kind).toBe('unavailable');
    expect(describeReturnError(apiError(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(describeReturnError(new Error('rede'))).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });
});
