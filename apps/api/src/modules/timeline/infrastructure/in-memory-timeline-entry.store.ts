import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineEntryStore, TimelineInsertOutcome } from '../application/ports.js';
import type { ProcessTimelineEntry } from '../domain/timeline-entry.js';

/**
 * Timeline em memória (modo de identidade fake — local/dev/test sem banco — e testes), com a mesma
 * unicidade `(tenantId, sourceEventId, type)` da tabela. As linhas só servem para inspeção.
 */
export class InMemoryTimelineEntryStore implements TimelineEntryStore {
  readonly rows: ProcessTimelineEntry[] = [];

  insert(_tx: TenantTx, entry: ProcessTimelineEntry): Promise<TimelineInsertOutcome> {
    const exists = this.rows.some(
      (row) =>
        row.tenantId === entry.tenantId &&
        row.sourceEventId === entry.sourceEventId &&
        row.type === entry.type,
    );
    if (exists) return Promise.resolve('duplicate');
    this.rows.push(entry);
    return Promise.resolve('inserted');
  }
}
