import type { ActorType, AuditAction, AuditCategory, AuditResult } from '@contrataflow/types';

import { Prisma } from '#shared/database/prisma.js';

import type { AuditRecord, SealedAuditRecord } from '../domain/audit-record.js';
import type { JsonObject, JsonValue } from '../domain/canonical-json.js';

/** Linha de `audit_logs` lida pela aplicação (enums e uuids em texto, IP por `host(ip)`). */
export interface AuditLogRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly tenant_id: string | null;
  readonly actor_type: string;
  readonly actor_user_id: string | null;
  readonly actor_name: string | null;
  readonly actor_membership_id: string | null;
  readonly on_behalf_of_user_id: string | null;
  readonly action: string;
  readonly category: string;
  readonly result: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly process_id: string | null;
  readonly changes: JsonValue[] | null;
  readonly metadata: JsonObject;
  readonly reason_code: string | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly correlation_id: string | null;
  readonly request_id: string | null;
  readonly session_id_hash: string | null;
}

export interface SealedAuditLogRow extends AuditLogRow {
  readonly row_hash: string;
}

/** Colunas na forma do `rowHash` (README do módulo: `host(ip)`, enums e uuids em texto). */
export const AUDIT_LOG_COLUMNS = Prisma.sql`
  id::text, occurred_at, tenant_id::text, actor_type::text, actor_user_id::text, actor_name,
  actor_membership_id::text, on_behalf_of_user_id::text, action, category::text, result::text,
  entity_type, entity_id::text, process_id::text, changes, metadata, reason_code,
  host(ip) AS ip, user_agent, correlation_id, request_id, session_id_hash`;

/** Registro lido do banco na forma do `rowHash` (US-074 recalcula a partir daqui). */
export function toAuditRecord(row: AuditLogRow): AuditRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    tenantId: row.tenant_id,
    actorType: row.actor_type as ActorType,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorMembershipId: row.actor_membership_id,
    onBehalfOfUserId: row.on_behalf_of_user_id,
    action: row.action as AuditAction,
    category: row.category as AuditCategory,
    result: row.result as AuditResult,
    entityType: row.entity_type,
    entityId: row.entity_id,
    processId: row.process_id,
    changes: row.changes,
    metadata: row.metadata,
    reasonCode: row.reason_code,
    ip: row.ip,
    userAgent: row.user_agent,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    sessionIdHash: row.session_id_hash,
  };
}

/** Registro com o `rowHash` GRAVADO (consulta e exportação — US-075). */
export function toSealedAuditRecord(row: SealedAuditLogRow): SealedAuditRecord {
  return { ...toAuditRecord(row), rowHash: row.row_hash };
}
