import { describe, expect, it } from 'vitest';

import {
  auditCriteriaOf,
  auditFilterKeys,
  auditFiltersMetadata,
  compareAuditRecords,
  isAfterAuditCursor,
  matchesAuditCriteria,
} from './audit-log-query.js';
import { seal } from './audit-record.js';
import type { AuditRecord } from './audit-record.js';

const T = '0192d075-0000-7000-8000-00000000000a';
const OTHER = '0192d075-0000-7000-8000-00000000000b';
const ACTOR = '0192d075-0000-7000-8000-0000000000a1';
const PROCESS = '0192d075-0000-7000-8000-0000000000f0';
const WEEK = { occurredFrom: '2026-09-01T00:00:00Z', occurredTo: '2026-09-07T23:59:59Z' };

function rec(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return seal({
    id: '0192d075-0000-7000-8000-000000000001',
    occurredAt: new Date('2026-09-03T10:00:00.000Z'),
    tenantId: T,
    actorType: 'USER',
    actorUserId: ACTOR,
    actorName: 'Ana',
    actorMembershipId: null,
    onBehalfOfUserId: null,
    action: 'process.create',
    category: 'DATA_CHANGE',
    result: 'SUCCESS',
    entityType: 'Process',
    entityId: PROCESS,
    processId: PROCESS,
    changes: null,
    metadata: {},
    reasonCode: null,
    ip: null,
    userAgent: null,
    correlationId: null,
    requestId: null,
    sessionIdHash: null,
    ...overrides,
  });
}

describe('critérios da consulta da trilha (US-075 · RN-AUD-17)', () => {
  it('sem filtros opcionais: só tenant e período (inclusivo nos dois extremos)', () => {
    const criteria = auditCriteriaOf(T, WEEK);
    expect(criteria).toMatchObject({
      tenantId: T,
      actorUserIds: null,
      actions: null,
      categories: null,
      results: null,
      entityType: null,
      entityId: null,
      processId: null,
    });
    expect(matchesAuditCriteria(rec(), criteria)).toBe(true);
    expect(matchesAuditCriteria(rec({ occurredAt: new Date(WEEK.occurredFrom) }), criteria)).toBe(
      true,
    );
    expect(matchesAuditCriteria(rec({ occurredAt: new Date(WEEK.occurredTo) }), criteria)).toBe(
      true,
    );
    expect(
      matchesAuditCriteria(rec({ occurredAt: new Date('2026-09-08T00:00:00Z') }), criteria),
    ).toBe(false);
    expect(matchesAuditCriteria(rec({ tenantId: OTHER }), criteria)).toBe(false);
    expect(matchesAuditCriteria(rec({ tenantId: null }), criteria)).toBe(false);
  });

  it('E entre filtros, OU dentro do mesmo; registro sem o campo não casa o filtro', () => {
    const criteria = auditCriteriaOf(T, {
      ...WEEK,
      action: ['process.create', 'process.update'],
      result: ['SUCCESS'],
      actorUserId: [ACTOR],
    });
    expect(matchesAuditCriteria(rec(), criteria)).toBe(true);
    expect(matchesAuditCriteria(rec({ action: 'process.update' }), criteria)).toBe(true);
    expect(matchesAuditCriteria(rec({ action: 'process.cancel' }), criteria)).toBe(false);
    expect(matchesAuditCriteria(rec({ result: 'DENIED', reasonCode: 'X' }), criteria)).toBe(false);
    expect(matchesAuditCriteria(rec({ actorUserId: null }), criteria)).toBe(false);
    const byEntity = auditCriteriaOf(T, {
      ...WEEK,
      entityType: 'Process',
      entityId: PROCESS,
      processId: PROCESS,
      category: ['DATA_CHANGE'],
    });
    expect(matchesAuditCriteria(rec(), byEntity)).toBe(true);
    expect(matchesAuditCriteria(rec({ entityType: 'Document' }), byEntity)).toBe(false);
    expect(matchesAuditCriteria(rec({ entityId: null }), byEntity)).toBe(false);
    expect(matchesAuditCriteria(rec({ processId: null }), byEntity)).toBe(false);
    expect(matchesAuditCriteria(rec({ category: 'WORKFLOW' }), byEntity)).toBe(false);
  });

  it('ordem `occurredAt DESC, id DESC` e cursor estritamente depois da posição', () => {
    const older = rec({ id: '0192d075-0000-7000-8000-000000000002', occurredAt: new Date(1) });
    const sameTimeLow = rec({
      id: '0192d075-0000-7000-8000-000000000003',
      occurredAt: new Date(5),
    });
    const sameTimeHigh = rec({
      id: '0192d075-0000-7000-8000-000000000004',
      occurredAt: new Date(5),
    });
    const sorted = [older, sameTimeLow, sameTimeHigh].sort(compareAuditRecords);
    expect(sorted.map((item) => item.id)).toEqual([sameTimeHigh.id, sameTimeLow.id, older.id]);
    expect(compareAuditRecords(older, older)).toBe(0);
    expect(isAfterAuditCursor(older, null)).toBe(true);
    expect(isAfterAuditCursor(sameTimeLow, sameTimeHigh)).toBe(true);
    expect(isAfterAuditCursor(sameTimeHigh, sameTimeHigh)).toBe(false);
    expect(isAfterAuditCursor(sameTimeHigh, sameTimeLow)).toBe(false);
  });

  it('chaves dos filtros usados (log) e os filtros para o metadata da auditoria', () => {
    const filters = { ...WEEK, action: ['process.create' as const], processId: PROCESS };
    expect(auditFilterKeys(filters)).toEqual(['action', 'processId']);
    expect(auditFiltersMetadata(filters)).toEqual({
      ...WEEK,
      actorUserId: null,
      action: ['process.create'],
      category: null,
      result: null,
      entityType: null,
      entityId: null,
      processId: PROCESS,
    });
  });
});
