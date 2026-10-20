import { createHash } from 'node:crypto';

import { uuidv7 } from '@contrataflow/observability';
import { AUDIT_ACTIONS } from '@contrataflow/types';
import type { AuditAction, AuditResult } from '@contrataflow/types';

import type { WorkerDatabase } from '#shared/database/worker-database.js';

/*
 * Auditoria das ações de operador sobre as filas (events.md §7 · US-083): `queue_dashboard.access`,
 * `outbox.republish`, `dead_letter.retry`, `dead_letter.discard`, sempre com
 * `actorType = PLATFORM_OPERATOR`. Grava em `audit_logs` pelo papel `cf_worker` — de plataforma
 * (`tenant_id` nulo) ou no tenant do job/evento afetado (visível ao administrador — DEC-139).
 * O `rowHash` segue exatamente o da API (RN-AUD-08: JCS/RFC 8785 + SHA-256 sobre os campos de
 * `HASHED_FIELDS`); um teste fixa o vetor calculado pela implementação da API.
 */

export type QueueAuditAction = Extract<
  AuditAction,
  'queue_dashboard.access' | 'outbox.republish' | 'dead_letter.retry' | 'dead_letter.discard'
>;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface QueueAuditEntry {
  readonly action: QueueAuditAction;
  readonly result: Extract<AuditResult, 'SUCCESS' | 'DENIED'>;
  /** Obrigatório quando negado (`audit_logs_reason_required`). */
  readonly reasonCode?: string;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly tenantId: string | null;
  readonly entityId?: string | null;
  readonly metadata: Readonly<Record<string, Json>>;
  readonly correlationId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface QueueAuditPort {
  record(entry: QueueAuditEntry): Promise<void>;
}

/** JCS (RFC 8785) — mesma serialização de `apps/api/.../canonical-json.ts`. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON canônico: número não finito');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.toWellFormed());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, child]) => `${canonicalJson(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  throw new Error(`JSON canônico: tipo ${typeof value}`);
}

/**
 * Registro na forma gravada: todo campo de `HASHED_FIELDS` explícito. Gravado pelo worker como
 * operador de plataforma (filas) ou como `SYSTEM` (`audit.seal` — US-074).
 */
export interface AuditRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly tenantId: string | null;
  readonly actorType: 'PLATFORM_OPERATOR' | 'SYSTEM';
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly actorMembershipId: null;
  readonly onBehalfOfUserId: null;
  readonly action: AuditAction;
  readonly category: string;
  readonly result: AuditResult;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly processId: string | null;
  readonly changes: null;
  readonly metadata: Readonly<Record<string, Json>>;
  readonly reasonCode: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string | null;
  readonly requestId: null;
  readonly sessionIdHash: null;
}

const HASHED_FIELDS = [
  'id',
  'occurredAt',
  'tenantId',
  'actorType',
  'actorUserId',
  'actorName',
  'actorMembershipId',
  'onBehalfOfUserId',
  'action',
  'category',
  'result',
  'entityType',
  'entityId',
  'processId',
  'changes',
  'metadata',
  'reasonCode',
  'ip',
  'userAgent',
  'correlationId',
  'requestId',
  'sessionIdHash',
] as const satisfies readonly (keyof AuditRow)[];

export function rowHashOf(row: AuditRow): string {
  const fields: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    fields[field] = field === 'occurredAt' ? row.occurredAt.toISOString() : row[field];
  }
  return createHash('sha256').update(canonicalJson(fields), 'utf8').digest('hex');
}

const ENTITY_TYPE: Readonly<Record<QueueAuditAction, string | null>> = {
  'queue_dashboard.access': null,
  'outbox.republish': 'OutboxEvent',
  'dead_letter.retry': null,
  'dead_letter.discard': null,
};

export class PlatformAuditWriter implements QueueAuditPort {
  constructor(
    private readonly database: Pick<WorkerDatabase, 'platformTransaction' | 'tenantTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: QueueAuditEntry): Promise<void> {
    const row: AuditRow = {
      id: uuidv7(),
      occurredAt: this.now(),
      tenantId: entry.tenantId,
      actorType: 'PLATFORM_OPERATOR',
      actorUserId: entry.actorUserId,
      actorName: entry.actorName?.slice(0, 200) ?? null,
      actorMembershipId: null,
      onBehalfOfUserId: null,
      action: entry.action,
      category: AUDIT_ACTIONS[entry.action].category,
      result: entry.result,
      entityType: entry.entityId ? ENTITY_TYPE[entry.action] : null,
      entityId: entry.entityId ?? null,
      processId: null,
      changes: null,
      metadata: entry.metadata,
      reasonCode: entry.reasonCode ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 512) ?? null,
      correlationId: entry.correlationId.slice(0, 64),
      requestId: null,
      sessionIdHash: null,
    };
    const rowHash = rowHashOf(row);
    const insert = (client: {
      query: (sql: string, params: readonly unknown[]) => Promise<unknown>;
    }) =>
      client.query(
        `INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, actor_user_id, actor_name,
           action, category, result, entity_type, entity_id, metadata, reason_code, ip, user_agent,
           correlation_id, row_hash)
         VALUES ($1, $2, $3, 'PLATFORM_OPERATOR', $4, $5, $6, $7::audit_category, $8::audit_result,
           $9, $10, $11::jsonb, $12, $13::inet, $14, $15, $16)`,
        [
          row.id,
          row.occurredAt,
          row.tenantId,
          row.actorUserId,
          row.actorName,
          row.action,
          row.category,
          row.result,
          row.entityType,
          row.entityId,
          JSON.stringify(row.metadata),
          row.reasonCode,
          row.ip,
          row.userAgent,
          row.correlationId,
          rowHash,
        ],
      );
    const { tenantId } = row;
    if (tenantId === null) await this.database.platformTransaction(insert);
    else await this.database.tenantTransaction(tenantId, insert);
  }
}
