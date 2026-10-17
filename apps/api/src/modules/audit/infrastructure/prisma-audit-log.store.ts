import { Injectable } from '@nestjs/common';

import { isMissingPartitionError } from '#shared/database/errors.js';
import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { AUDIT_LOG_COLUMNS, toSealedAuditRecord } from './audit-log-row.js';
import type { SealedAuditLogRow } from './audit-log-row.js';
import { AuditPartitionMissingError } from '../application/ports.js';
import type { AuditLogStore, CoalesceQuery, SessionRecordQuery } from '../application/ports.js';
import { coalesceStateFrom } from '../domain/audit-coalescer.js';
import type { CoalesceState } from '../domain/audit-coalescer.js';
import type { AuditLogCriteria, AuditLogPageQuery } from '../domain/audit-log-query.js';
import type { SealedAuditRecord } from '../domain/audit-record.js';

/**
 * Predicado de AUD-01/AUD-03 (US-075 · RN-AUD-17): tenant explícito (além da RLS), período
 * inclusivo SEMPRE presente — poda as partições mensais fora do intervalo — e os filtros
 * opcionais por igualdade/`ANY`, cada um servido por um índice `(tenant_id, …, occurred_at DESC)`
 * de entities.md §4. Todo valor é parâmetro, nunca texto interpolado.
 */
export function auditCriteriaSql(criteria: AuditLogCriteria): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`tenant_id = ${criteria.tenantId}::uuid`,
    Prisma.sql`occurred_at >= ${criteria.occurredFrom}`,
    Prisma.sql`occurred_at <= ${criteria.occurredTo}`,
  ];
  if (criteria.actorUserIds !== null) {
    conditions.push(Prisma.sql`actor_user_id = ANY(${[...criteria.actorUserIds]}::uuid[])`);
  }
  if (criteria.actions !== null) {
    conditions.push(Prisma.sql`action = ANY(${[...criteria.actions]}::text[])`);
  }
  if (criteria.categories !== null) {
    conditions.push(Prisma.sql`category = ANY(${[...criteria.categories]}::audit_category[])`);
  }
  if (criteria.results !== null) {
    conditions.push(Prisma.sql`result = ANY(${[...criteria.results]}::audit_result[])`);
  }
  if (criteria.entityType !== null) {
    conditions.push(Prisma.sql`entity_type = ${criteria.entityType}`);
  }
  if (criteria.entityId !== null) {
    conditions.push(Prisma.sql`entity_id = ${criteria.entityId}::uuid`);
  }
  if (criteria.processId !== null) {
    conditions.push(Prisma.sql`process_id = ${criteria.processId}::uuid`);
  }
  return conditions;
}

/** Uma página por cursor: comparação de linha `(occurred_at, id) < (…)`, na direção dos índices. */
export function buildAuditSearchSql(query: AuditLogPageQuery): Prisma.Sql {
  const conditions = auditCriteriaSql(query);
  if (query.after !== null) {
    conditions.push(
      Prisma.sql`(occurred_at, id) < (${query.after.occurredAt}, ${query.after.id}::uuid)`,
    );
  }
  return Prisma.sql`
    SELECT ${AUDIT_LOG_COLUMNS}, row_hash
      FROM audit_logs
     WHERE ${Prisma.join(conditions, ' AND ')}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${query.take}`;
}

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

  async existsForSession(tx: TenantTx, query: SessionRecordQuery): Promise<boolean> {
    // `occurred_at` por igualdade poda a consulta à partição do mês; o índice
    // `audit_logs_action_idx (tenant_id, action, occurred_at DESC)` localiza as linhas do instante.
    const rows = await tx.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found
        FROM audit_logs
       WHERE tenant_id = ${query.tenantId}::uuid
         AND action = ${query.action}
         AND occurred_at = ${query.occurredAt}
         AND session_id_hash = ${query.sessionIdHash}
       LIMIT 1`;
    return rows.length > 0;
  }

  /** AUD-01/AUD-03 (US-075): uma instrução, sob a RLS do tenant (`app.tenant_id` da transação). */
  async search(tx: TenantTx, query: AuditLogPageQuery): Promise<SealedAuditRecord[]> {
    const rows = await tx.$queryRaw<SealedAuditLogRow[]>(buildAuditSearchSql(query));
    return rows.map(toSealedAuditRecord);
  }

  async findById(tx: TenantTx, tenantId: string, id: string): Promise<SealedAuditRecord | null> {
    // Sem `occurred_at` não há poda: o índice da PK `(id, occurred_at)` de cada partição resolve.
    const rows = await tx.$queryRaw<SealedAuditLogRow[]>`
      SELECT ${AUDIT_LOG_COLUMNS}, row_hash
        FROM audit_logs
       WHERE tenant_id = ${tenantId}::uuid
         AND id = ${id}::uuid
       LIMIT 1`;
    const [row] = rows;
    return row ? toSealedAuditRecord(row) : null;
  }

  async count(tx: TenantTx, criteria: AuditLogCriteria, cap: number): Promise<number> {
    // Contagem limitada ao teto: acima de `maxRows` o número exato não importa (RN-AUD-19).
    const [row] = await tx.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total
        FROM (SELECT 1
                FROM audit_logs
               WHERE ${Prisma.join(auditCriteriaSql(criteria), ' AND ')}
               LIMIT ${cap}) AS capped`;
    return row?.total ?? 0;
  }
}
