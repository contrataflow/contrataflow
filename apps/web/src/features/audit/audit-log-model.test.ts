import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  actorOptions,
  advancedFilterCount,
  changeValueText,
  classifyAuditError,
  coalescedRange,
  countExportedRows,
  defaultAuditFilters,
  summarizedValue,
  validateAuditFilters,
} from './audit-log-model';

const TZ = 'America/Sao_Paulo';
const MESSAGES = {
  required: 'Informe a data e a hora.',
  invalidId: 'Informe um identificador válido.',
};
const BASE = defaultAuditFilters(new Date('2026-10-17T12:00:00Z'), TZ);
const BOM = String.fromCharCode(0xfeff);
const UUID = '0192a000-0000-7000-8000-0000000000a1';

describe('filtros da aba "Registros" (US-075)', () => {
  it('padrão: últimos 7 dias no fuso da instituição, sem filtros opcionais', () => {
    expect(BASE).toMatchObject({ from: '2026-10-10T09:00', to: '2026-10-17T09:00', actions: [] });
    expect(advancedFilterCount(BASE)).toBe(0);
  });

  it('valida com o schema da API e monta a query só com o que foi preenchido', () => {
    const result = validateAuditFilters(
      {
        ...BASE,
        actions: ['process.create', 'process.update'],
        result: 'DENIED',
        entityType: ' Process ',
        processId: UUID,
      },
      TZ,
      MESSAGES,
    );
    expect(result).toEqual({
      ok: true,
      query: {
        occurredFrom: '2026-10-10T12:00:00Z',
        occurredTo: '2026-10-17T12:00:00Z',
        action: 'process.create,process.update',
        result: 'DENIED',
        entityType: 'Process',
        processId: UUID,
      },
    });
  });

  it('V-01/V-02 e ids inválidos: erros por campo', () => {
    expect(validateAuditFilters({ ...BASE, from: '' }, TZ, MESSAGES)).toEqual({
      ok: false,
      errors: { from: MESSAGES.required },
    });
    expect(validateAuditFilters({ ...BASE, from: '2026-06-01T00:00' }, TZ, MESSAGES)).toEqual({
      ok: false,
      errors: { to: 'Selecione um período de até 90 dias.' },
    });
    expect(validateAuditFilters({ ...BASE, to: '2026-10-01T00:00' }, TZ, MESSAGES)).toEqual({
      ok: false,
      errors: { to: 'A data final deve ser posterior à inicial.' },
    });
    expect(validateAuditFilters({ ...BASE, entityId: 'x', processId: 'y' }, TZ, MESSAGES)).toEqual({
      ok: false,
      errors: { entityId: MESSAGES.invalidId, processId: MESSAGES.invalidId },
    });
  });

  it('atores distintos dos registros, por nome, mantendo o selecionado', () => {
    expect(
      actorOptions(
        [
          { actorUserId: 'b', actorName: 'Bruno' },
          { actorUserId: 'a', actorName: 'Ana' },
          { actorUserId: 'b', actorName: 'Bruno' },
          { actorUserId: null, actorName: 'Sistema' },
        ],
        'z',
      ),
    ).toEqual([
      { id: 'a', name: 'Ana' },
      { id: 'b', name: 'Bruno' },
      { id: 'z', name: 'z' },
    ]);
  });
});

describe('valores do diff e metadata (RN-AUD-18 · FA-05)', () => {
  it('resumo { hash, length } é reconhecido; o resto vira texto', () => {
    expect(summarizedValue({ hash: 'ab', length: 3 })).toEqual({ hash: 'ab', length: 3 });
    expect(summarizedValue({ hash: 'ab', length: 3, extra: 1 })).toBeNull();
    expect(summarizedValue('texto')).toBeNull();
    expect(changeValueText(null)).toBeNull();
    expect(changeValueText('***.456.789-**')).toBe('***.456.789-**');
    expect(changeValueText({ quantity: 3 })).toBe('{"quantity":3}');
  });

  it('coalescido só com o intervalo de salvamentos no metadata', () => {
    expect(coalescedRange({ coalesce: { firstSavedAt: 'a', lastSavedAt: 'b' } })).toEqual({
      first: 'a',
      last: 'b',
    });
    expect(coalescedRange({ coalesce: { revision: 3 } })).toBeNull();
    expect(coalescedRange({})).toBeNull();
  });
});

describe('arquivo exportado e erros', () => {
  it('conta registros do CSV (aspas com quebra de linha não contam) e do NDJSON', () => {
    const csv = `${BOM}id,notes\r\n1,"linha\r\nquebrada"\r\n2,"a ""b"""\r\n`;
    expect(countExportedRows(csv, 'csv')).toBe(2);
    expect(countExportedRows(`${BOM}id,notes\r\n`, 'csv')).toBe(0);
    expect(countExportedRows('id\r\n1', 'csv')).toBe(1);
    expect(countExportedRows('{"a":1}\n{"a":2}\n', 'ndjson')).toBe(2);
    expect(countExportedRows('', 'ndjson')).toBe(0);
  });

  it('classifica as falhas de AUD-01/02/03', () => {
    const error = (
      status: number,
      code: string,
      extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
    ) => new ApiError({ status, code, correlationId: 'c-1', ...extra });
    expect(classifyAuditError(error(403, 'MFA_REQUIRED'))).toEqual({ kind: 'mfa' });
    expect(classifyAuditError(error(403, 'PERMISSION_DENIED'))).toEqual({ kind: 'forbidden' });
    expect(classifyAuditError(error(404, 'NOT_FOUND'))).toEqual({ kind: 'notFound' });
    expect(classifyAuditError(error(429, 'RATE_LIMITED'))).toEqual({ kind: 'rateLimited' });
    expect(
      classifyAuditError(error(422, 'EXPORT_TOO_LARGE', { detail: 'Muitos registros' })),
    ).toEqual({ kind: 'tooLarge', message: 'Muitos registros' });
    expect(
      classifyAuditError(
        error(422, 'VALIDATION_ERROR', {
          errors: [{ field: 'occurredTo', code: 'OUT_OF_RANGE', message: 'Até 90 dias.' }],
        }),
      ),
    ).toEqual({ kind: 'validation', message: 'Até 90 dias.' });
    expect(classifyAuditError(error(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
      correlationId: 'c-1',
    });
    expect(classifyAuditError(error(409, 'X'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(classifyAuditError(new Error('x'))).toEqual({ kind: 'unexpected', correlationId: null });
  });
});
