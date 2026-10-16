import type { ActorType, TimelineEntryType, TimelineVisibility } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { Prisma } from '#shared/database/prisma.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineEntryStore, TimelineInsertOutcome } from '../application/ports.js';
import type { ProcessTimelineEntry, TimelineParams } from '../domain/timeline-entry.js';
import type { TimelineFeedSearch } from '../domain/timeline-feed.js';

interface TimelineDbRow {
  id: string;
  tenant_id: string;
  process_id: string;
  occurred_at: Date;
  type: string;
  actor_type: ActorType;
  actor_id: string | null;
  actor_name: string | null;
  actor_department_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  movement_id: string | null;
  params: TimelineParams | null;
  visibility: TimelineVisibility;
  source_event_id: string;
}

/**
 * Predicado de PRC-12 (US-060): processo, POL-09 (RN-TML-13 — no `WHERE`, para `hasMore` e o
 * cursor contarem só o visível), grupo → tipos, autores, período inclusivo e o cursor por
 * comparação de linha `(occurred_at, id) < (…)`, na direção do índice
 * `process_timeline_entries_process_idx`. Todo valor é parâmetro, nunca texto interpolado.
 */
export function buildTimelineFeedSql(search: TimelineFeedSearch): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`t.process_id = ${search.processId}::uuid`];
  if (!search.includeRestricted) {
    conditions.push(Prisma.sql`t.visibility = 'STANDARD'::timeline_visibility`);
  }
  if (search.types !== null) {
    conditions.push(Prisma.sql`t.type = ANY(${[...search.types]}::text[])`);
  }
  if (search.actorIds !== null) {
    conditions.push(Prisma.sql`t.actor_id = ANY(${[...search.actorIds]}::uuid[])`);
  }
  if (search.occurredFrom !== null) {
    conditions.push(Prisma.sql`t.occurred_at >= ${search.occurredFrom}`);
  }
  if (search.occurredTo !== null) {
    conditions.push(Prisma.sql`t.occurred_at <= ${search.occurredTo}`);
  }
  if (search.after !== null) {
    conditions.push(
      Prisma.sql`(t.occurred_at, t.id) < (${search.after.occurredAt}, ${search.after.id}::uuid)`,
    );
  }
  return Prisma.sql`
    SELECT t.id, t.tenant_id, t.process_id, t.occurred_at, t.type, t.actor_type, t.actor_id,
           t.actor_name, t.actor_department_name, t.entity_type, t.entity_id, t.movement_id,
           t.params, t.visibility, t.source_event_id
      FROM process_timeline_entries t
     WHERE ${Prisma.join(conditions, ' AND ')}
     ORDER BY t.occurred_at DESC, t.id DESC
     LIMIT ${search.take}`;
}

function toEntry(row: TimelineDbRow): ProcessTimelineEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    processId: row.process_id,
    occurredAt: row.occurred_at,
    type: row.type as TimelineEntryType,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorDepartmentName: row.actor_department_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    movementId: row.movement_id,
    params: row.params ?? {},
    visibility: row.visibility,
    sourceEventId: row.source_event_id,
  };
}

/**
 * `process_timeline_entries` no PostgreSQL (US-059): um INSERT parametrizado no `tx` do caso de
 * uso, sob a RLS do tenant (`WITH CHECK`). A unicidade `(tenant_id, source_event_id, type)` absorve
 * o reprocessamento — inclusive concorrente: a segunda transação espera a primeira e não grava.
 * US-060: a leitura paginada por cursor de PRC-12.
 */
@Injectable()
export class PrismaTimelineEntryStore implements TimelineEntryStore {
  async insert(tx: TenantTx, entry: ProcessTimelineEntry): Promise<TimelineInsertOutcome> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO process_timeline_entries (
        id, tenant_id, process_id, occurred_at, type, actor_type, actor_id, actor_name,
        actor_department_name, entity_type, entity_id, movement_id, params, visibility,
        source_event_id
      ) VALUES (
        ${entry.id}::uuid, ${entry.tenantId}::uuid, ${entry.processId}::uuid, ${entry.occurredAt},
        ${entry.type}, ${entry.actorType}::actor_type, ${entry.actorId}::uuid, ${entry.actorName},
        ${entry.actorDepartmentName}, ${entry.entityType}, ${entry.entityId}::uuid,
        ${entry.movementId}::uuid, ${JSON.stringify(entry.params)}::jsonb,
        ${entry.visibility}::timeline_visibility, ${entry.sourceEventId}::uuid
      )
      ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING
      RETURNING id`;
    return inserted.length === 1 ? 'inserted' : 'duplicate';
  }

  /** PRC-12 (US-060): uma instrução, sob a RLS do tenant (`app.tenant_id` da transação). */
  async list(tx: TenantTx, search: TimelineFeedSearch): Promise<ProcessTimelineEntry[]> {
    const rows = await tx.$queryRaw<TimelineDbRow[]>(buildTimelineFeedSql(search));
    return rows.map(toEntry);
  }
}
