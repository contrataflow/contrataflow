import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { PlatformAuditWriter, canonicalJson, rowHashOf } from './platform-audit.js';
import type { AuditRow } from './platform-audit.js';

const ROW: AuditRow = {
  id: '0192f0a0-0000-7000-8000-000000000001',
  occurredAt: new Date('2026-10-15T12:00:00.123Z'),
  tenantId: null,
  actorType: 'PLATFORM_OPERATOR',
  actorUserId: '0192f0a0-0000-7000-8000-000000000002',
  actorName: 'Operadora',
  actorMembershipId: null,
  onBehalfOfUserId: null,
  action: 'dead_letter.retry',
  category: 'SYSTEM',
  result: 'SUCCESS',
  entityType: null,
  entityId: null,
  processId: null,
  changes: null,
  metadata: { ticket: 'OPS-1', source: { queue: 'email', attempts: 5 }, ação: 'ç' },
  reasonCode: null,
  ip: null,
  userAgent: null,
  correlationId: 'cli-1234567',
  requestId: null,
  sessionIdHash: null,
};

describe('auditoria de plataforma das filas (events.md §7 · RN-AUD-08)', () => {
  it('rowHash idêntico ao da API (vetor calculado por apps/api/.../audit-record.ts)', () => {
    expect(rowHashOf(ROW)).toBe('202859aea0bd4d578331ad9c82f20997f44c6fc051477ee946248e2be9df515d');
  });

  it('JSON canônico: chaves ordenadas, sem espaços; recusa número não finito e tipo estranho', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonicalJson(Number.NaN)).toThrow('não finito');
    expect(() => canonicalJson(undefined)).toThrow('tipo undefined');
  });

  it('grava como PLATFORM_OPERATOR, de plataforma ou no tenant afetado, com o hash da linha', async () => {
    const calls: { tenant: string | null; params: readonly unknown[] }[] = [];
    const clientFor = (tenant: string | null): SqlClient => ({
      query: (_sql: string, params: readonly unknown[] = []) => {
        calls.push({ tenant, params });
        return Promise.resolve({ rows: [] as never[], rowCount: 1 });
      },
    });
    const writer = new PlatformAuditWriter(
      {
        platformTransaction: (work) => work(clientFor(null)),
        tenantTransaction: (tenantId, work) => work(clientFor(tenantId)),
      },
      () => new Date('2026-10-15T12:00:00.000Z'),
    );
    await writer.record({
      action: 'queue_dashboard.access',
      result: 'DENIED',
      reasonCode: 'PERMISSION_DENIED',
      actorUserId: null,
      actorName: null,
      tenantId: null,
      metadata: { actorType: 'PLATFORM_OPERATOR' },
      correlationId: 'corr-dash-0001',
    });
    await writer.record({
      action: 'outbox.republish',
      result: 'SUCCESS',
      actorUserId: ROW.actorUserId,
      actorName: 'Operadora',
      tenantId: '0192f0a0-0000-7000-8000-00000000000a',
      entityId: '0192f0a0-0000-7000-8000-0000000000ee',
      metadata: { ticket: 'OPS-2' },
      correlationId: 'corr-dash-0002',
      ip: '10.0.0.1',
      userAgent: 'cli',
    });
    expect(calls.map((call) => call.tenant)).toEqual([
      null,
      '0192f0a0-0000-7000-8000-00000000000a',
    ]);
    const [first, second] = calls;
    expect(first?.params.slice(5, 12)).toEqual([
      'queue_dashboard.access',
      'ACCESS',
      'DENIED',
      null,
      null,
      '{"actorType":"PLATFORM_OPERATOR"}',
      'PERMISSION_DENIED',
    ]);
    expect(second?.params.slice(5, 10)).toEqual([
      'outbox.republish',
      'SYSTEM',
      'SUCCESS',
      'OutboxEvent',
      '0192f0a0-0000-7000-8000-0000000000ee',
    ]);
    expect(String(second?.params[15])).toMatch(/^[0-9a-f]{64}$/);
  });
});
