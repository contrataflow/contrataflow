import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineEntryStore, TimelineInsertOutcome } from '../application/ports.js';
import type { ProcessTimelineEntry } from '../domain/timeline-entry.js';

/**
 * `process_timeline_entries` no PostgreSQL (US-059): um INSERT parametrizado no `tx` do caso de
 * uso, sob a RLS do tenant (`WITH CHECK`). A unicidade `(tenant_id, source_event_id, type)` absorve
 * o reprocessamento — inclusive concorrente: a segunda transação espera a primeira e não grava.
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
}
