import { uuidv7 } from '@contrataflow/observability';
import { AUDIT_ACTIONS } from '@contrataflow/types';
import { Logger } from '@nestjs/common';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { HousekeepingTask } from './tenant-housekeeping.job.js';
import { rowHashOf } from '../admin/platform-audit.js';
import type { AuditRow } from '../admin/platform-audit.js';

/** Consultor revogado pela expiração (o nome é congelado na timeline — RN-TML-04). */
interface ExpiredParticipantRow {
  readonly id: string;
  readonly process_id: string;
  readonly role: string;
  readonly name: string | null;
}

const SYSTEM_ACTOR = { type: 'SYSTEM', userId: null, membershipId: null } as const;

/**
 * `participants-expire` (US-012 · RN-PROC-134 · queues.md §4.8 · tarefa diária do
 * `tenant-housekeeping`): consultores (`CONSULTANT`) com `expires_at` vencido são revogados pelo
 * sistema (`revoked_by_id` nulo) e, na MESMA transação do tenant, a concessão `ProcessAccess`
 * (`PARTICIPANT`, origem = participante) é revogada, a timeline `PARTICIPANT_REMOVED` é gravada com
 * o nome congelado, a auditoria `process.participant_remove` (`SYSTEM`, `reason = EXPIRED`) e o
 * evento `ProcessParticipantRemoved` vão para `audit_logs`/`outbox_events` (o relay publica).
 * Idempotente — `UPDATE … WHERE revoked_at IS NULL`. Não é o controle de acesso: a autorização já
 * nega o consultor vencido a cada requisição (RN-PROC-135); o job materializa o estado e emite.
 */
export class ParticipantsExpireTask implements HousekeepingTask {
  readonly name = 'participants-expire';
  private readonly logger = new Logger('ProcessMaintenance');

  constructor(private readonly now: () => Date = () => new Date()) {}

  async run(client: SqlClient, tenantId: string): Promise<Readonly<Record<string, number>>> {
    const now = this.now();
    const expired = await client.query<ExpiredParticipantRow>(
      `WITH expired AS (
         UPDATE process_participants
            SET revoked_at = $2, updated_at = $2
          WHERE tenant_id = $1 AND revoked_at IS NULL AND role = 'CONSULTANT'
            AND expires_at <= $2
          RETURNING id, process_id, user_id, role::text AS role
       )
       SELECT e.id, e.process_id, e.role,
              COALESCE(NULLIF(btrim(u.social_name), ''), u.name) AS name
         FROM expired e
         LEFT JOIN users u ON u.id = e.user_id`,
      [tenantId, now],
    );
    const rows = expired.rows;
    if (rows.length === 0) {
      this.logger.log({ event: 'process.participants_expired', tenantId, count: 0 });
      return { expired: 0 };
    }
    await client.query(
      `UPDATE process_access
          SET revoked_at = $2
        WHERE tenant_id = $1 AND reason = 'PARTICIPANT' AND revoked_at IS NULL
          AND source_id = ANY($3::uuid[])`,
      [tenantId, now, rows.map((row) => row.id)],
    );
    const correlationId = `participants-expire:${uuidv7()}`.slice(0, 64);
    for (const row of rows) {
      const eventId = uuidv7();
      await client.query(
        `INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, event_version,
           aggregate_type, aggregate_id, process_id, payload, metadata, occurred_at)
         VALUES ($1, $2, 'ProcessParticipantRemoved', 'process.participant_removed', 1,
           'Process', $3, $3, $4::jsonb, $5::jsonb, $6)`,
        [
          eventId,
          tenantId,
          row.process_id,
          JSON.stringify({ participantId: row.id, reason: 'EXPIRED' }),
          JSON.stringify({ actor: SYSTEM_ACTOR, correlationId, causationId: null }),
          now,
        ],
      );
      // Mesma projeção do `TimelineProjector` (events.md §5): idempotente por evento + tipo.
      await client.query(
        `INSERT INTO process_timeline_entries (id, tenant_id, process_id, occurred_at, type,
           actor_type, actor_id, actor_name, actor_department_name, entity_type, entity_id,
           movement_id, params, visibility, source_event_id)
         VALUES ($1, $2, $3, $4, 'PARTICIPANT_REMOVED', 'SYSTEM'::actor_type, NULL, NULL, NULL,
           'ProcessParticipant', $5, NULL, $6::jsonb, 'STANDARD'::timeline_visibility, $7)
         ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING`,
        [
          uuidv7(),
          tenantId,
          row.process_id,
          now,
          row.id,
          JSON.stringify({ name: row.name, role: row.role, reason: 'EXPIRED' }),
          eventId,
        ],
      );
      await insertAudit(client, auditRowOf(tenantId, row, now, correlationId));
    }
    this.logger.log({ event: 'process.participants_expired', tenantId, count: rows.length });
    return { expired: rows.length };
  }
}

function auditRowOf(
  tenantId: string,
  row: ExpiredParticipantRow,
  occurredAt: Date,
  correlationId: string,
): AuditRow {
  return {
    id: uuidv7(),
    occurredAt,
    tenantId,
    actorType: 'SYSTEM',
    actorUserId: null,
    actorName: 'Sistema',
    actorMembershipId: null,
    onBehalfOfUserId: null,
    action: 'process.participant_remove',
    category: AUDIT_ACTIONS['process.participant_remove'].category,
    result: 'SUCCESS',
    entityType: 'ProcessParticipant',
    entityId: row.id,
    processId: row.process_id,
    changes: null,
    metadata: { reason: 'EXPIRED', role: row.role },
    reasonCode: null,
    ip: null,
    userAgent: null,
    correlationId,
    requestId: null,
    sessionIdHash: null,
  };
}

async function insertAudit(client: SqlClient, row: AuditRow): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, actor_name, action, category,
       result, entity_type, entity_id, process_id, metadata, correlation_id, row_hash)
     VALUES ($1, $2, $3, 'SYSTEM', $4, $5, $6::audit_category, $7::audit_result, $8, $9, $10,
       $11::jsonb, $12, $13)`,
    [
      row.id,
      row.occurredAt,
      row.tenantId,
      row.actorName,
      row.action,
      row.category,
      row.result,
      row.entityType,
      row.entityId,
      row.processId,
      JSON.stringify(row.metadata),
      row.correlationId,
      rowHashOf(row),
    ],
  );
}
