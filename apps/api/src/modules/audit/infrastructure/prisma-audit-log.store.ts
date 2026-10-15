import { Injectable } from '@nestjs/common';

import { isMissingPartitionError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { AuditPartitionMissingError } from '../application/ports.js';
import type { AuditLogStore, CoalesceQuery } from '../application/ports.js';
import { coalesceStateFrom } from '../domain/audit-coalescer.js';
import type { CoalesceState } from '../domain/audit-coalescer.js';
import type { SealedAuditRecord } from '../domain/audit-record.js';

/**
 * `audit_logs` no PostgreSQL (US-073): INSERT por SQL parametrizado no `tx` do caso de uso — sem
 * RETURNING, porque o registro de plataforma (tenant nulo) não é legível pela aplicação (DEC-071).
 */
@Injectable()
export class PrismaAuditLogStore implements AuditLogStore {
  async insert(tx: TenantTx, record: SealedAuditRecord): Promise<void> {
    const changes = record.changes === null ? null : JSON.stringify(record.changes);
    try {
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, occurred_at, tenant_id, actor_type, actor_user_id, actor_name, actor_membership_id,
          on_behalf_of_user_id, action, category, result, entity_type, entity_id, process_id,
          changes, metadata, reason_code, ip, user_agent, correlation_id, request_id,
          session_id_hash, row_hash
        ) VALUES (
          ${record.id}::uuid, ${record.occurredAt}, ${record.tenantId}::uuid,
          ${record.actorType}::actor_type, ${record.actorUserId}::uuid, ${record.actorName},
          ${record.actorMembershipId}::uuid, ${record.onBehalfOfUserId}::uuid, ${record.action},
          ${record.category}::audit_category, ${record.result}::audit_result, ${record.entityType},
          ${record.entityId}::uuid, ${record.processId}::uuid, ${changes}::jsonb,
          ${JSON.stringify(record.metadata)}::jsonb, ${record.reasonCode}, ${record.ip}::inet,
          ${record.userAgent}, ${record.correlationId}, ${record.requestId},
          ${record.sessionIdHash}, ${record.rowHash}
        )`;
    } catch (error) {
      if (isMissingPartitionError(error)) {
        throw new AuditPartitionMissingError(record.occurredAt, { cause: error });
      }
      throw error;
    }
  }

  async findLastCoalesced(tx: TenantTx, query: CoalesceQuery): Promise<CoalesceState | null> {
    // Índice (tenant_id, entity_type, entity_id, occurred_at DESC), só nas partições da janela.
    const rows = await tx.$queryRaw<{ state: unknown }[]>`
      SELECT metadata -> 'coalesce' AS state
        FROM audit_logs
       WHERE tenant_id = ${query.tenantId}::uuid
         AND entity_type = ${query.entityType}
         AND entity_id = ${query.entityId}::uuid
         AND occurred_at >= ${query.since}
         AND action = ${query.action}
         AND actor_user_id = ${query.actorUserId}::uuid
         AND (metadata -> 'coalesce' ->> 'scope') IS NOT DISTINCT FROM ${query.scope}::text
       ORDER BY occurred_at DESC
       LIMIT 1`;
    return coalesceStateFrom(rows[0]?.state ?? null);
  }
}
