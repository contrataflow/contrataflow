import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LIST_MESSAGES,
  approvalListQuerySchema,
  formatApprovalListSort,
  isApprovalPeriodValid,
  parseApprovalListSort,
} from './approval-list.js';

/* US-057 — query de APV-01 (RN-INBOX-15/18 · V-01..V-04), a mesma no SCR-014 e na API. */

const DEPARTMENT = '0192e057-0000-7000-8000-0000000000a1';

describe('approvalListQuerySchema', () => {
  it('sem parâmetros: PENDING, -requestedAt, página 1 de 20', () => {
    expect(approvalListQuerySchema.parse({})).toEqual({
      statuses: ['PENDING'],
      subjectType: null,
      requestingDepartmentId: null,
      requestedFrom: null,
      requestedTo: null,
      q: null,
      sort: { field: 'requestedAt', direction: 'desc' },
      page: 1,
      pageSize: 20,
    });
  });

  it('status múltiplo por vírgula ou repetição, sem duplicatas (OU)', () => {
    expect(approvalListQuerySchema.parse({ status: 'APPROVED,REJECTED' }).statuses).toEqual([
      'APPROVED',
      'REJECTED',
    ]);
    expect(
      approvalListQuerySchema.parse({ status: ['PENDING', 'RETURNED', 'PENDING'] }).statuses,
    ).toEqual(['PENDING', 'RETURNED']);
    expect(approvalListQuerySchema.parse({ status: '' }).statuses).toEqual(['PENDING']);
  });

  it('filtros e ordenação válidos', () => {
    const query = approvalListQuerySchema.parse({
      subjectType: 'DOCUMENT',
      requestingDepartmentId: DEPARTMENT,
      requestedFrom: '2026-10-01',
      requestedTo: '2026-10-01',
      q: '  obras ',
      sort: 'dueAt',
      page: '2',
      pageSize: '100',
    });
    expect(query).toMatchObject({
      subjectType: 'DOCUMENT',
      requestingDepartmentId: DEPARTMENT,
      requestedFrom: '2026-10-01',
      requestedTo: '2026-10-01',
      q: 'obras',
      sort: { field: 'dueAt', direction: 'asc' },
      page: 2,
      pageSize: 100,
    });
  });

  it('V-01: status ou subjectType fora do enum', () => {
    expect(approvalListQuerySchema.safeParse({ status: 'PENDING,DONE' }).success).toBe(false);
    expect(approvalListQuerySchema.safeParse({ subjectType: 'PROCESS' }).success).toBe(false);
  });

  it('V-02: período invertido → "O período informado é inválido." em requestedTo', () => {
    const result = approvalListQuerySchema.safeParse({
      requestedFrom: '2026-10-10',
      requestedTo: '2026-10-01',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['requestedTo'],
        message: APPROVAL_LIST_MESSAGES.invalidPeriod,
      }),
    ]);
  });

  it('busca com menos de 2 caracteres, sort fora da lista e pageSize acima de 100', () => {
    expect(approvalListQuerySchema.safeParse({ q: ' a ' }).success).toBe(false);
    const sort = approvalListQuerySchema.safeParse({ sort: 'title' });
    expect(sort.error?.issues[0]).toMatchObject({ path: ['sort'] });
    expect(approvalListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });

  it('parâmetro desconhecido é recusado (query estrita)', () => {
    expect(approvalListQuerySchema.safeParse({ view: 'ALL' }).success).toBe(false);
  });
});

describe('ordenação e período (RN-INBOX-18 · V-02)', () => {
  it('parse/format ida e volta', () => {
    for (const value of ['requestedAt', '-requestedAt', 'dueAt', '-dueAt', 'code', '-code']) {
      const sort = parseApprovalListSort(value);
      expect(sort).not.toBeNull();
      if (sort) expect(formatApprovalListSort(sort)).toBe(value);
    }
    expect(parseApprovalListSort('--code')).toBeNull();
    expect(parseApprovalListSort('enteredAt')).toBeNull();
  });

  it('período: só invertido é inválido; ausente ou vazio não conta', () => {
    expect(isApprovalPeriodValid('2026-10-01', '2026-10-02')).toBe(true);
    expect(isApprovalPeriodValid('2026-10-02', '2026-10-02')).toBe(true);
    expect(isApprovalPeriodValid('2026-10-03', '2026-10-02')).toBe(false);
    expect(isApprovalPeriodValid(undefined, '2026-10-02')).toBe(true);
    expect(isApprovalPeriodValid('2026-10-03', '')).toBe(true);
  });
});
