import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { ParticipantsExpireTask } from './participants-expire.js';
import { rowHashOf } from '../admin/platform-audit.js';
import type { AuditRow } from '../admin/platform-audit.js';

const TENANT = '0192d012-0000-7000-8000-00000000000a';
const PROCESS = '0192d012-0000-7000-8000-0000000000b1';
const DIEGO = '0192d012-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-23T06:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

/** Cliente que devolve o consultor vencido no `UPDATE … RETURNING` e grava as demais instruções. */
function fakeClient(expired: readonly { id: string; name: string | null }[]) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      const rows = sql.includes('WITH expired AS')
        ? expired.map((row) => ({ ...row, process_id: PROCESS, role: 'CONSULTANT' }))
        : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as SqlClient;
  return { client, calls };
}

describe('participants-expire (US-012 · RN-PROC-134)', () => {
  it('[Sucesso] Expiração automática do consultor: revoga, ProcessAccess, timeline, auditoria e evento na mesma transação', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client, calls } = fakeClient([{ id: DIEGO, name: 'Diego Alves' }]);
    const result = await new ParticipantsExpireTask(() => NOW).run(client, TENANT);
    expect(result).toEqual({ expired: 1 });

    const [revoke, access, outbox, timeline, audit] = calls;
    // Só consultores ativos do tenant com validade vencida; o sistema revoga (sem revoked_by_id).
    expect(revoke?.sql).toMatch(/UPDATE process_participants/);
    expect(revoke?.sql).toMatch(/role = 'CONSULTANT'/);
    expect(revoke?.sql).toMatch(/revoked_at IS NULL/);
    expect(revoke?.sql).toMatch(/expires_at <= \$2/);
    expect(revoke?.sql).not.toMatch(/revoked_by_id/);
    expect(revoke?.params).toEqual([TENANT, NOW]);

    expect(access?.sql).toMatch(/UPDATE process_access/);
    expect(access?.sql).toMatch(/reason = 'PARTICIPANT'/);
    expect(access?.params).toEqual([TENANT, NOW, [DIEGO]]);

    expect(outbox?.sql).toMatch(/INSERT INTO outbox_events/);
    expect(outbox?.sql).toMatch(/'ProcessParticipantRemoved', 'process\.participant_removed'/);
    expect(JSON.parse(String(outbox?.params[3]))).toEqual({
      participantId: DIEGO,
      reason: 'EXPIRED',
    });
    expect(JSON.parse(String(outbox?.params[4]))).toMatchObject({
      actor: { type: 'SYSTEM', userId: null, membershipId: null },
      causationId: null,
    });

    expect(timeline?.sql).toMatch(/'PARTICIPANT_REMOVED', 'SYSTEM'::actor_type/);
    expect(timeline?.sql).toMatch(/ON CONFLICT \(tenant_id, source_event_id, type\) DO NOTHING/);
    expect(JSON.parse(String(timeline?.params[5]))).toEqual({
      name: 'Diego Alves',
      role: 'CONSULTANT',
      reason: 'EXPIRED',
    });
    // O evento é a origem da entrada (idempotência do TimelineProjector).
    expect(timeline?.params[6]).toBe(outbox?.params[0]);

    expect(audit?.sql).toMatch(/INSERT INTO audit_logs/);
    expect(audit?.params.slice(3, 10)).toEqual([
      'Sistema',
      'process.participant_remove',
      'DATA_CHANGE',
      'SUCCESS',
      'ProcessParticipant',
      DIEGO,
      PROCESS,
    ]);
    expect(JSON.parse(String(audit?.params[10]))).toEqual({
      reason: 'EXPIRED',
      role: 'CONSULTANT',
    });
    // `row_hash` igual ao da API para a mesma linha (RN-AUD-08).
    const row: AuditRow = {
      id: String(audit?.params[0]),
      occurredAt: NOW,
      tenantId: TENANT,
      actorType: 'SYSTEM',
      actorUserId: null,
      actorName: 'Sistema',
      actorMembershipId: null,
      onBehalfOfUserId: null,
      action: 'process.participant_remove',
      category: 'DATA_CHANGE',
      result: 'SUCCESS',
      entityType: 'ProcessParticipant',
      entityId: DIEGO,
      processId: PROCESS,
      changes: null,
      metadata: { reason: 'EXPIRED', role: 'CONSULTANT' },
      reasonCode: null,
      ip: null,
      userAgent: null,
      correlationId: String(audit?.params[11]),
      requestId: null,
      sessionIdHash: null,
    };
    expect(audit?.params[12]).toBe(rowHashOf(row));
  });

  it('sem consultor vencido: nada além da revogação idempotente', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { client, calls } = fakeClient([]);
    await expect(new ParticipantsExpireTask(() => NOW).run(client, TENANT)).resolves.toEqual({
      expired: 0,
    });
    expect(calls).toHaveLength(1);
  });
});
