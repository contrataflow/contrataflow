import type { ActorType, AuditAction, AuditCategory, AuditResult } from '@contrataflow/types';

import { canonicalJson, sha256Hex } from './canonical-json.js';
import type { JsonObject, JsonValue } from './canonical-json.js';

/**
 * Registro de auditoria (entities.md §4 `AuditLog`), exatamente como é gravado: todo campo é
 * explícito (`null` quando ausente) porque todos entram no `rowHash`.
 */
export interface AuditRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly tenantId: string | null;
  readonly actorType: ActorType;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly actorMembershipId: string | null;
  readonly onBehalfOfUserId: string | null;
  readonly action: AuditAction;
  readonly category: AuditCategory;
  readonly result: AuditResult;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly processId: string | null;
  readonly changes: JsonValue[] | null;
  readonly metadata: Readonly<JsonObject>;
  readonly reasonCode: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string | null;
  readonly requestId: string | null;
  readonly sessionIdHash: string | null;
}

export interface SealedAuditRecord extends AuditRecord {
  readonly rowHash: string;
}

/**
 * Campos cobertos pelo `rowHash` (RN-AUD-08): todos os de `AuditLog` exceto o próprio `rowHash`,
 * com os nomes de entities.md. US-074 (verificação dos selos) recalcula a partir daqui.
 */
export const HASHED_FIELDS = [
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
] as const satisfies readonly (keyof AuditRecord)[];

/**
 * Forma canônica do registro para o hash: JCS (RFC 8785) de um objeto com exatamente os
 * `HASHED_FIELDS`, `occurredAt` em ISO 8601 UTC com milissegundos (`2026-10-14T21:00:00.000Z`).
 */
export function canonicalRecord(record: AuditRecord): string {
  const fields: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    fields[field] = field === 'occurredAt' ? record.occurredAt.toISOString() : record[field];
  }
  return canonicalJson(fields);
}

/** `rowHash` = SHA-256 (hex) da forma canônica — calculado uma vez, antes do INSERT (RN-AUD-08). */
export function rowHashOf(record: AuditRecord): string {
  return sha256Hex(canonicalRecord(record));
}

export function seal(record: AuditRecord): SealedAuditRecord {
  return { ...record, rowHash: rowHashOf(record) };
}
