import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineEntryStore, TimelineInsertOutcome } from '../application/ports.js';
import type { ProcessTimelineEntry } from '../domain/timeline-entry.js';
import { compareTimelineEntries, matchesTimelineSearch } from '../domain/timeline-feed.js';
import type { TimelineFeedSearch } from '../domain/timeline-feed.js';

/**
 * Timeline em memória (modo de identidade fake — local/dev/test sem banco — e testes), com a mesma
 * unicidade `(tenantId, sourceEventId, type)` da tabela. A leitura (US-060) simula a RLS pelo
 * tenant da requisição e aplica os mesmos critérios e ordem do SQL.
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

  list(_tx: TenantTx, search: TimelineFeedSearch): Promise<ProcessTimelineEntry[]> {
    const tenantId = requireRequestContext().tenantId;
    return Promise.resolve(
      this.rows
        .filter((row) => row.tenantId === tenantId && matchesTimelineSearch(row, search))
        .sort(compareTimelineEntries)
        .slice(0, search.take),
    );
  }
}
