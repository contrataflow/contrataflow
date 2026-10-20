import type { ProcessListItemDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  duplicateDfdBody,
  eligibleTargets,
  initialValues,
  missingTarget,
  problemOf,
  searchTextOf,
} from './duplicate-dfd-model';

const item = (id: string, status: ProcessListItemDto['status']) =>
  ({ id, status, code: id, title: id }) as ProcessListItemDto;

describe('Modelo do diálogo "Duplicar DFD" (US-018)', () => {
  it('padrão: novo processo com PROCESS_CREATE; sem ele, a busca do processo existente', () => {
    expect(initialValues(true)).toEqual({ targetType: 'NEW_PROCESS', target: null });
    expect(initialValues(false)).toEqual({ targetType: 'EXISTING_PROCESS', target: null });
  });

  it('corpo do DFD-05: novo processo sem destino; existente com o id escolhido', () => {
    expect(duplicateDfdBody({ targetType: 'NEW_PROCESS', target: item('p1', 'DRAFT') })).toEqual({
      targetType: 'NEW_PROCESS',
    });
    expect(
      duplicateDfdBody({ targetType: 'EXISTING_PROCESS', target: item('p1', 'DRAFT') }),
    ).toEqual({ targetType: 'EXISTING_PROCESS', targetProcessId: 'p1' });
  });

  it('processo existente sem escolha não é enviado', () => {
    expect(missingTarget({ targetType: 'EXISTING_PROCESS', target: null })).toBe(true);
    expect(missingTarget({ targetType: 'NEW_PROCESS', target: null })).toBe(false);
  });

  it('busca só com 2 caracteres úteis', () => {
    expect(searchTextOf(' a ')).toBeNull();
    expect(searchTextOf('  cimento ')).toBe('cimento');
  });

  it('RN-DFD-73: só processos editáveis e nunca o da origem', () => {
    const found = eligibleTargets(
      [
        item('origem', 'IN_PROGRESS'),
        item('a', 'DRAFT'),
        item('b', 'IN_PROGRESS'),
        item('c', 'RETURNED'),
        item('d', 'SUSPENDED'),
        item('e', 'AWAITING_APPROVAL'),
        item('f', 'COMPLETED'),
      ],
      'origem',
    );
    expect(found.map((process) => process.id)).toEqual(['a', 'b', 'c']);
  });

  describe('problemOf', () => {
    const error = (init: ConstructorParameters<typeof ApiError>[0]) => new ApiError(init);

    it('409 DOCUMENT_ALREADY_EXISTS leva o código e o id do DFD existente', () => {
      expect(
        problemOf(
          error({
            status: 409,
            code: 'DOCUMENT_ALREADY_EXISTS',
            problem: {
              meta: { code: 'DFD 0006/2026', existingDfdId: 'dfd-1' },
            } as never,
          }),
        ),
      ).toEqual({ kind: 'exists', code: 'DFD 0006/2026', dfdId: 'dfd-1' });
      expect(problemOf(error({ status: 409, code: 'DOCUMENT_ALREADY_EXISTS' }))).toEqual({
        kind: 'exists',
        code: null,
        dfdId: null,
      });
    });

    it('classifica os demais erros do contrato', () => {
      expect(
        problemOf(error({ status: 422, code: 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE' })).kind,
      ).toBe('stage');
      expect(
        problemOf(
          error({
            status: 422,
            code: 'VALIDATION_ERROR',
            errors: [
              { field: 'targetProcessId', code: 'REFERENCE_NOT_FOUND', message: 'Selecione.' },
            ],
          }),
        ).kind,
      ).toBe('target');
      expect(
        problemOf(error({ status: 409, code: 'INVALID_PROCESS_STATUS', detail: 'x' })),
      ).toEqual({
        kind: 'process',
        detail: 'x',
      });
      expect(
        problemOf(error({ status: 403, code: 'PERMISSION_DENIED', detail: 'Sem acesso' })),
      ).toEqual({ kind: 'permission', detail: 'Sem acesso' });
      expect(problemOf(error({ status: 404, code: 'DFD_NOT_FOUND' })).kind).toBe('notFound');
      expect(problemOf(error({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' })).kind).toBe(
        'unavailable',
      );
      expect(problemOf(error({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' })).kind).toBe(
        'keyReused',
      );
      expect(
        problemOf(error({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c-9' })),
      ).toEqual({ kind: 'unexpected', correlationId: 'c-9' });
    });
  });
});
