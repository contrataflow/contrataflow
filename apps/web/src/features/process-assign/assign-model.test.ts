import type { UserLookupItem } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  QUEUE_OPTION,
  assignBodyOf,
  canQueue,
  describeAssignError,
  memberOptions,
  validateAssign,
} from './assign-model';

/* US-050 · SCR-115 — regras puras do diálogo "Atribuir responsável". */

const FELIPE = '0192a000-0000-7000-8000-000000000001';
const JULIANA = '0192a000-0000-7000-8000-000000000002';
const REASON = 'Felipe está de férias';

const member = (id: string, name: string): UserLookupItem => ({
  id,
  name,
  email: `${name.toLowerCase()}@a.test`,
  membershipType: 'INTERNAL',
  membershipExpiresAt: null,
});

const apiError = (status: number, code: string, errors: ApiError['errors'] = []) =>
  new ApiError({ status, code, correlationId: 'corr-1', errors });

describe('assign-model (US-050)', () => {
  it('a lista omite o responsável atual; "Deixar na fila" só com responsável (FA-02)', () => {
    const members = [member(FELIPE, 'Felipe'), member(JULIANA, 'Juliana')];
    expect(memberOptions(members, FELIPE).map((item) => item.id)).toEqual([JULIANA]);
    expect(memberOptions(members, null)).toHaveLength(2);
    expect(canQueue(FELIPE)).toBe(true);
    expect(canQueue(null)).toBe(false);
  });

  it('V-01: sem escolha = erro no responsável', () => {
    expect(validateAssign({ selection: '', reason: '' }, null)).toEqual({
      assignee: 'Selecione um responsável ou deixe na fila da unidade.',
    });
  });

  it('RN-TRAM-39: motivo obrigatório na reatribuição e opcional na primeira atribuição', () => {
    expect(validateAssign({ selection: JULIANA, reason: '  ' }, FELIPE)).toEqual({
      reason: 'Informe o motivo da troca de responsável.',
    });
    expect(validateAssign({ selection: QUEUE_OPTION, reason: '' }, FELIPE).reason).toBeDefined();
    expect(validateAssign({ selection: JULIANA, reason: '' }, null)).toEqual({});
    expect(validateAssign({ selection: JULIANA, reason: REASON }, FELIPE)).toEqual({});
  });

  it('V-03: motivo informado precisa de 10 a 2.000 caracteres, mesmo quando opcional', () => {
    expect(validateAssign({ selection: JULIANA, reason: 'curto' }, null)).toEqual({
      reason: 'O motivo deve ter ao menos 10 caracteres.',
    });
    expect(validateAssign({ selection: JULIANA, reason: 'x'.repeat(2001) }, FELIPE).reason).toBe(
      'O motivo pode ter até 2.000 caracteres.',
    );
  });

  it('corpo: fila = assigneeId null; motivo aparado e omitido quando vazio', () => {
    expect(assignBodyOf({ selection: QUEUE_OPTION, reason: `  ${REASON} ` })).toEqual({
      assigneeId: null,
      reason: REASON,
    });
    expect(assignBodyOf({ selection: JULIANA, reason: '' })).toEqual({ assigneeId: JULIANA });
  });

  it('cada recusa da API vira o comportamento da tabela "Casos de erro"', () => {
    expect(describeAssignError(apiError(412, 'VERSION_CONFLICT'))).toEqual({ kind: 'stale' });
    expect(describeAssignError(apiError(409, 'INVALID_PROCESS_STATUS'))).toEqual({
      kind: 'status',
    });
    expect(describeAssignError(apiError(403, 'PERMISSION_DENIED'))).toEqual({
      kind: 'permission',
    });
    expect(describeAssignError(apiError(404, 'PROCESS_NOT_FOUND'))).toEqual({ kind: 'notFound' });
    expect(describeAssignError(apiError(422, 'ASSIGNEE_NOT_ELIGIBLE'))).toEqual({
      kind: 'notEligible',
    });
    expect(
      describeAssignError(
        apiError(422, 'VALIDATION_ERROR', [
          { field: 'assigneeId', code: 'REFERENCE_NOT_FOUND', message: 'Selecione.' },
        ]),
      ),
    ).toEqual({ kind: 'reference' });
    expect(
      describeAssignError(
        apiError(422, 'VALIDATION_ERROR', [
          {
            field: 'reason',
            code: 'REQUIRED',
            message: 'Informe o motivo da troca de responsável.',
          },
        ]),
      ),
    ).toEqual({
      kind: 'field',
      field: 'reason',
      message: 'Informe o motivo da troca de responsável.',
    });
    expect(
      describeAssignError(
        apiError(422, 'VALIDATION_ERROR', [
          { field: 'assigneeId', code: 'INVALID_FORMAT', message: 'Selecione um responsável.' },
        ]),
      ),
    ).toMatchObject({ kind: 'field', field: 'assignee' });
    expect(describeAssignError(apiError(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
    });
    expect(describeAssignError(apiError(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'corr-1',
    });
    expect(describeAssignError(new Error('rede'))).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });
});
