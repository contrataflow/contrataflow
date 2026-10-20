import { describe, expect, it } from 'vitest';

import {
  PROCESS_LIST_MESSAGES,
  parseProcessListParams,
  processListQuerySchema,
  processListSortSchema,
} from './process-list.js';

const ID = '0192f000-0000-7000-8000-0000000000c1';
const ID2 = '0192f000-0000-7000-8000-0000000000c2';

const messagesOf = (input: Record<string, unknown>) => {
  const result = processListQuerySchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => [issue.path[0], issue.message]);
};

describe('processListQuerySchema (US-002 · PRC-01)', () => {
  it('aplica os padrões e ignora parâmetros desconhecidos (RN-PROC-20/28)', () => {
    expect(processListQuerySchema.parse({ internalNotes: 'x' })).toEqual({ page: 1, pageSize: 20 });
  });

  it('separa vírgulas e repetições em OU, sem repetir valores (RN-PROC-20)', () => {
    const query = processListQuerySchema.parse({
      status: 'IN_PROGRESS, RETURNED,IN_PROGRESS',
      priority: ['HIGH', 'URGENT'],
      year: '2026,2025',
      page: '2',
      pageSize: '50',
    });
    expect(query).toMatchObject({
      status: ['IN_PROGRESS', 'RETURNED'],
      priority: ['HIGH', 'URGENT'],
      year: [2026, 2025],
      page: 2,
      pageSize: 50,
    });
  });

  it('aceita os valores reservados me/none/mine combinados com UUIDs (RN-PROC-21)', () => {
    expect(
      processListQuerySchema.parse({
        currentResponsibleId: `me,none,${ID}`,
        currentDepartmentId: `mine,${ID2}`,
        modalityId: 'none',
      }),
    ).toMatchObject({
      currentResponsibleId: ['me', 'none', ID],
      currentDepartmentId: ['mine', ID2],
      modalityId: ['none'],
    });
    expect(messagesOf({ currentDepartmentId: 'me' })).toEqual([
      ['currentDepartmentId', PROCESS_LIST_MESSAGES.invalidOption],
    ]);
  });

  it('valida enum, UUID, busca, paginação, ano e booleanos (V-01..V-04, V-09)', () => {
    expect(messagesOf({ status: 'OPEN' })[0]?.[0]).toBe('status');
    expect(messagesOf({ requestingDepartmentId: 'abc' })[0]?.[0]).toBe('requestingDepartmentId');
    expect(messagesOf({ q: ' a ' })).toEqual([['q', PROCESS_LIST_MESSAGES.searchLength]]);
    expect(messagesOf({ q: 'x'.repeat(201) })[0]?.[0]).toBe('q');
    expect(messagesOf({ page: '0' })).toEqual([['page', PROCESS_LIST_MESSAGES.invalidPage]]);
    expect(messagesOf({ pageSize: '101' })).toEqual([
      ['pageSize', PROCESS_LIST_MESSAGES.invalidPage],
    ]);
    expect(messagesOf({ year: '1999' })).toEqual([['year', PROCESS_LIST_MESSAGES.invalidYear]]);
    expect(messagesOf({ overdue: 'sim' })[0]?.[0]).toBe('overdue');
    expect(processListQuerySchema.parse({ overdue: 'false' }).overdue).toBe(false);
  });

  it('limita 50 valores por filtro (V-08)', () => {
    const many = Array.from({ length: 51 }, (_, index) => String(2000 + index)).join(',');
    expect(messagesOf({ year: many })).toEqual([['year', PROCESS_LIST_MESSAGES.tooManyValues]]);
  });

  it('recusa intervalo invertido e valor inválido (V-06/V-07)', () => {
    expect(messagesOf({ createdFrom: '2026-10-05', createdTo: '2026-10-01' })).toEqual([
      ['createdTo', PROCESS_LIST_MESSAGES.dateRange],
    ]);
    expect(messagesOf({ targetDateFrom: '2026-10-05', targetDateTo: '2026-10-01' })[0]?.[0]).toBe(
      'targetDateTo',
    );
    expect(messagesOf({ estimatedValueMin: '-1' })[0]?.[0]).toBe('estimatedValueMin');
    expect(messagesOf({ estimatedValueMin: '1.234' })[0]?.[0]).toBe('estimatedValueMin');
    expect(messagesOf({ estimatedValueMin: '100.10', estimatedValueMax: '100.09' })).toEqual([
      ['estimatedValueMax', PROCESS_LIST_MESSAGES.invalidValue],
    ]);
    expect(
      processListQuerySchema.safeParse({ estimatedValueMin: '100.1', estimatedValueMax: '100.10' })
        .success,
    ).toBe(true);
  });
});

describe('processListSortSchema (RN-PROC-27 · V-05)', () => {
  it('lê campos e direção, até 3', () => {
    expect(processListSortSchema.parse('-priority,currentStageDueAt')).toEqual([
      { field: 'priority', direction: 'desc' },
      { field: 'currentStageDueAt', direction: 'asc' },
    ]);
  });

  it.each(['internalNotes', 'updatedAt;DROP TABLE processes', 'code,-code', 'a,b,c,d', ''])(
    'recusa %s',
    (sort) => {
      expect(messagesOf({ sort })).toEqual([['sort', PROCESS_LIST_MESSAGES.invalidSort]]);
    },
  );

  it('recusa mais de 3 campos válidos', () => {
    expect(processListSortSchema.safeParse('code,title,status,priority').success).toBe(false);
  });
});

describe('parseProcessListParams (FA-03)', () => {
  it('mantém os válidos crus e descarta os inválidos', () => {
    expect(
      parseProcessListParams({
        status: 'IN_PROGRESS,RETURNED',
        sort: 'internalNotes',
        q: 'a',
        foo: 'bar',
        overdue: 'true',
      }),
    ).toEqual({
      params: { status: 'IN_PROGRESS,RETURNED', overdue: 'true' },
      invalid: ['sort', 'q'],
    });
  });

  it('descarta o par inteiro quando o intervalo vem invertido', () => {
    expect(
      parseProcessListParams({ createdFrom: '2026-10-05', createdTo: '2026-10-01', page: '2' }),
    ).toEqual({ params: { page: '2' }, invalid: ['createdTo', 'createdFrom'] });
  });
});
