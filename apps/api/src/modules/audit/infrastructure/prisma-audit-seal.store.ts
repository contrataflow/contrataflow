import type { ActorType, AuditAction, AuditCategory, AuditResult } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { AuditSealListCriteria, AuditSealStore } from '../application/ports.js';
import type { AuditRecord } from '../domain/audit-record.js';
import { SEAL_PERIOD_MS } from '../domain/audit-seal.js';
import type { AuditSeal, SealPeriod } from '../domain/audit-seal.js';
import type { JsonObject, JsonValue } from '../domain/canonical-json.js';

interface SealRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly first_audit_id: string;
  readonly last_audit_id: string;
  readonly record_count: number;
  readonly digest: string;
  readonly previous_seal_id: string | null;
  readonly chain_hash: string;
  readonly sealed_at: Date;
}

interface AuditRow {
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

function toSeal(row: SealRow): AuditSeal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    firstAuditId: row.first_audit_id,
    lastAuditId: row.last_audit_id,
    recordCount: row.record_count,
    digest: row.digest,
    previousSealId: row.previous_seal_id,
    chainHash: row.chain_hash,
    sealedAt: row.sealed_at,
  };
}

/** Registro lido do banco na forma do `rowHash` (README do módulo: `host(ip)`, enums em texto). */
function toRecord(row: AuditRow): AuditRecord {
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

/**
 * `audit_seals` e a releitura de `audit_logs` para a verificação (US-074). SQL parametrizado no
 * `tx` da `TenantTransaction`, com `tenant_id` explícito além da RLS (multi-tenancy.md §5.6).
 */
@Injectable()
export class PrismaAuditSealStore implements AuditSealStore {
  async list(
    tx: TenantTx,
    criteria: AuditSealListCriteria,
  ): Promise<{ readonly items: readonly AuditSeal[]; readonly total: number }> {
    const { tenantId, periodFrom, periodTo } = criteria;
    const rows = await tx.$queryRaw<(SealRow & { total: bigint })[]>`
      SELECT id::text, tenant_id::text, period_start, period_end, first_audit_id::text,
             last_audit_id::text, record_count, digest, previous_seal_id::text, chain_hash,
             sealed_at, count(*) OVER () AS total
        FROM audit_seals
       WHERE tenant_id = ${tenantId}::uuid
         AND (${periodFrom}::timestamptz IS NULL OR period_start >= ${periodFrom}::timestamptz)
         AND (${periodTo}::timestamptz IS NULL OR period_start <= ${periodTo}::timestamptz)
       ORDER BY period_start DESC
       LIMIT ${criteria.take} OFFSET ${criteria.skip}`;
    if (rows.length > 0) {
      return { items: rows.map(toSeal), total: Number(rows[0]?.total ?? 0) };
    }
    // Página além do fim: o total ainda é o do filtro.
    const [count] = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total
        FROM audit_seals
       WHERE tenant_id = ${tenantId}::uuid
         AND (${periodFrom}::timestamptz IS NULL OR period_start >= ${periodFrom}::timestamptz)
         AND (${periodTo}::timestamptz IS NULL OR period_start <= ${periodTo}::timestamptz)`;
    return { items: [], total: Number(count?.total ?? 0) };
  }

  async findInRange(
    tx: TenantTx,
    query: {
      readonly tenantId: string;
      readonly from: Date;
      readonly to: Date;
      readonly limit: number;
    },
  ): Promise<readonly AuditSeal[]> {
    const rows = await tx.$queryRaw<SealRow[]>`
      SELECT id::text, tenant_id::text, period_start, period_end, first_audit_id::text,
             last_audit_id::text, record_count, digest, previous_seal_id::text, chain_hash,
             sealed_at
        FROM audit_seals
       WHERE tenant_id = ${query.tenantId}::uuid
         AND period_start >= ${query.from}
         AND period_start <= ${query.to}
       ORDER BY period_start
       LIMIT ${query.limit}`;
    return rows.map(toSeal);
  }

  async findPredecessor(tx: TenantTx, tenantId: string, before: Date): Promise<AuditSeal | null> {
    const rows = await tx.$queryRaw<SealRow[]>`
      SELECT id::text, tenant_id::text, period_start, period_end, first_audit_id::text,
             last_audit_id::text, record_count, digest, previous_seal_id::text, chain_hash,
             sealed_at
        FROM audit_seals
       WHERE tenant_id = ${tenantId}::uuid
         AND period_start < ${before}
       ORDER BY period_start DESC
       LIMIT 1`;
    const [row] = rows;
    return row ? toSeal(row) : null;
  }

  async periodRecords(
    tx: TenantTx,
    tenantId: string,
    period: SealPeriod,
  ): Promise<readonly AuditRecord[]> {
    // Índice (tenant_id, occurred_at DESC), só na partição do mês do período. Limite superior
    // exclusivo na hora seguinte — o mesmo do worker, mesmo com microssegundos gravados.
    const next = new Date(period.start.getTime() + SEAL_PERIOD_MS);
    const rows = await tx.$queryRaw<AuditRow[]>`
      SELECT id::text, occurred_at, tenant_id::text, actor_type::text, actor_user_id::text,
             actor_name, actor_membership_id::text, on_behalf_of_user_id::text, action,
             category::text, result::text, entity_type, entity_id::text, process_id::text,
             changes, metadata, reason_code, host(ip) AS ip, user_agent, correlation_id,
             request_id, session_id_hash
        FROM audit_logs
       WHERE tenant_id = ${tenantId}::uuid
         AND occurred_at >= ${period.start}
         AND occurred_at < ${next}
       ORDER BY occurred_at, id`;
    return rows.map(toRecord);
  }
}
