import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { TIMELINE_MESSAGES } from '@contrataflow/validation';
import type { ProcessTimelineQuery, TimelineEntryDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isTransientDatabaseError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { cursorResult, decodeCursor } from '#shared/http/pagination.js';
import type { CursorResult } from '#shared/http/pagination.js';

import { TIMELINE_ENTRY_STORE, TIMELINE_TRANSACTIONS } from './ports.js';
import type { TimelineEntryStore, TimelineTransactions } from './ports.js';
import { timelineReadMetrics } from './timeline-telemetry.js';
import { CollaborationFacade } from '../../collaboration/application/collaboration.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import type { ProcessTimelineEntry } from '../domain/timeline-entry.js';
import { timelineCriteriaOf, timelineFilterKeys } from '../domain/timeline-feed.js';
import type { TimelineCursorPosition } from '../domain/timeline-feed.js';

/** Posição opaca do cursor de PRC-12 (o cliente nunca interpreta): instante e id da última. */
const cursorPosition = z.strictObject({ o: z.iso.datetime(), i: z.uuid() });

/** V-02: cursor inválido ou corrompido → 422 com a mensagem da story (a UI reinicia a lista). */
function decodeTimelineCursor(cursor: string): TimelineCursorPosition {
  try {
    const position = decodeCursor(cursor, cursorPosition);
    return { occurredAt: new Date(position.o), id: position.i };
  } catch {
    throw validationError([
      { field: 'cursor', code: 'INVALID_FORMAT', message: TIMELINE_MESSAGES.invalidCursor },
    ]);
  }
}

/** `TimelineEntryPresenter` (RN-TML-14): `type` + `params`, nunca mensagem pronta. */
export function toTimelineEntryDto(entry: ProcessTimelineEntry): TimelineEntryDto {
  return {
    id: entry.id,
    occurredAt: entry.occurredAt.toISOString(),
    type: entry.type,
    actorType: entry.actorType,
    actorId: entry.actorId,
    actorName: entry.actorName,
    actorDepartmentName: entry.actorDepartmentName,
    entityType: entry.entityType,
    entityId: entry.entityId,
    movementId: entry.movementId,
    params: { ...entry.params },
    visibility: entry.visibility,
  };
}

/** Hash curto dos filtros aplicados (log `timeline.listed` — nunca os valores). */
export function filtersHashOf(query: ProcessTimelineQuery): string {
  const normalized = {
    group: query.group ? [...query.group].sort() : null,
    actorId: query.actorId ? [...query.actorId].sort() : null,
    occurredFrom: query.occurredFrom ?? null,
    occurredTo: query.occurredTo ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 12);
}

/**
 * `GetProcessTimelineHandler` — PRC-12 (US-060): a timeline do processo, mais recente primeiro,
 * por cursor, com filtros de grupo, autor e período. `PROCESS_VIEW` sobre o processo já foi
 * conferido pelo guard (não visível, inexistente ou de outro tenant = 404 `PROCESS_NOT_FOUND`);
 * aqui a POL-09 decide, uma vez por consulta, se as entradas `BUDGET_RESTRICTED` entram no filtro
 * da própria consulta (RN-TML-13). Somente leitura, `READ COMMITTED`, sem eventos.
 */
@Injectable()
export class GetProcessTimelineHandler {
  private readonly logger = new Logger('Timeline');

  constructor(
    @Inject(TIMELINE_ENTRY_STORE) private readonly entries: TimelineEntryStore,
    @Inject(TIMELINE_TRANSACTIONS) private readonly transactions: TimelineTransactions,
    private readonly processes: ProcessFacade,
    private readonly collaboration: CollaborationFacade,
  ) {}

  /**
   * US-071 (lacuna 3 da story): a entrada `COMMENT_ADDED` é imutável, mas o trecho de comentário
   * excluído (pelo autor ou por moderação) não é mais exibido — `excerpt` nulo e
   * `commentDeleted: true` (DEC-034 · RL-05). Uma leitura por página.
   */
  private async suppressDeletedExcerpts(
    tx: TenantTx,
    entries: readonly ProcessTimelineEntry[],
  ): Promise<ProcessTimelineEntry[]> {
    const commentIds = entries.flatMap((entry) =>
      entry.type === 'COMMENT_ADDED' && entry.entityId !== null ? [entry.entityId] : [],
    );
    if (commentIds.length === 0) return [...entries];
    const labels = await this.collaboration.commentLabels(tx, commentIds);
    return entries.map((entry) =>
      entry.type === 'COMMENT_ADDED' &&
      entry.entityId !== null &&
      labels.get(entry.entityId)?.isDeleted === true
        ? { ...entry, params: { ...entry.params, excerpt: null, commentDeleted: true } }
        : entry,
    );
  }

  async execute(
    processId: string,
    query: ProcessTimelineQuery,
  ): Promise<CursorResult<TimelineEntryDto>> {
    const after = query.cursor === undefined ? null : decodeTimelineCursor(query.cursor);
    const filterKeys = timelineFilterKeys(query);
    const started = performance.now();
    try {
      const result = await this.transactions.read(async (tx) => {
        const includeRestricted = await this.processes.canViewConfidentialBudget(tx, processId);
        const fetched = await this.entries.list(tx, {
          processId,
          ...timelineCriteriaOf(query),
          includeRestricted,
          after,
          take: query.limit + 1,
        });
        const visible = await this.suppressDeletedExcerpts(tx, fetched);
        return cursorResult(visible.map(toTimelineEntryDto), query.limit, (item) => ({
          o: item.occurredAt,
          i: item.id,
        }));
      });
      const durationMs = Math.round(performance.now() - started);
      timelineReadMetrics().listDuration.record(durationMs, { filtered: filterKeys.length > 0 });
      this.logger.log(
        {
          event: 'timeline.listed',
          processId,
          filterKeys,
          filtersHash: filtersHashOf(query),
          count: result.items.length,
          hasMore: result.meta.hasMore,
          durationMs,
        },
        'timeline.listed',
      );
      return result;
    } catch (error) {
      throw this.failure(error);
    }
  }

  /** `error timeline.query_failed` (sem params nem filtros) e banco fora do ar → 503. */
  private failure(error: unknown): unknown {
    if (error instanceof ApiError && error.status < 500) return error;
    const transient = isTransientDatabaseError(error);
    const mapped = transient ? new DatabaseUnavailableError(error) : error;
    this.logger.error(
      {
        event: 'timeline.query_failed',
        errorCode: mapped instanceof ApiError ? mapped.code : 'INTERNAL_ERROR',
        correlationId: requireRequestContext().correlationId,
      },
      'timeline.query_failed',
    );
    return mapped;
  }
}
