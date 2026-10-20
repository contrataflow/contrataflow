import { withSpan } from '@contrataflow/observability';
import type {
  PageMeta,
  TaskInboxCountersDto,
  TaskInboxItemDto,
  TaskInboxQuery,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isStatementTimeout } from '#shared/database/errors.js';
import { ApiError } from '#shared/errors/api-error.js';

import { InboxViewerResolver } from './inbox-viewer.resolver.js';
import { INBOX_CLOCK, INBOX_READER, INBOX_TRANSACTIONS } from './ports.js';
import type { InboxClock, InboxReader, InboxTransactions } from './ports.js';
import { recordInboxQuery } from './task-inbox-telemetry.js';
import { TaskInboxPresenter } from './task-inbox.presenter.js';
import { unitQueueApplies } from '../domain/task-inbox.js';

/*
 * `GetTaskInboxHandler` (TSK-01) e `GetTaskInboxCountersHandler` (TSK-02) — US-056: leituras puras
 * (sem evento nem auditoria) na transação de leitura do tenant, com `INBOX_VIEW` já conferido pela
 * rota. A lista e os contadores usam os mesmos predicados (`InboxReader`), cada um numa instrução
 * (RN-INBOX-09). Logs sem título/objeto do processo (story · "Logs").
 */

/** RN-INBOX-12: acima disto, `warn inbox.slow_query`. */
export const INBOX_SLOW_QUERY_MS = 500;

export interface TaskInboxResult {
  readonly items: TaskInboxItemDto[];
  readonly meta: PageMeta;
}

/** Logs, métrica e tradução de falhas comuns às duas consultas. */
@Injectable()
export class InboxQueryInstrumentation {
  private readonly logger = new Logger('TaskInbox');

  async run<T>(view: string, work: () => Promise<T>, countOf: (result: T) => number): Promise<T> {
    return withSpan('inbox.query', { 'cf.inbox.view': view }, async () => {
      const startedAt = performance.now();
      try {
        const result = await work();
        const durationMs = Math.round(performance.now() - startedAt);
        const context = requireRequestContext();
        const fields = {
          view,
          resultCount: countOf(result),
          durationMs,
          tenantId: context.tenantId,
          userId: context.actor.userId,
          correlationId: context.correlationId,
        };
        this.logger.log({ event: 'inbox.query', ...fields }, 'inbox.query');
        if (durationMs > INBOX_SLOW_QUERY_MS) {
          this.logger.warn({ event: 'inbox.slow_query', ...fields }, 'inbox.slow_query');
        }
        recordInboxQuery(view, durationMs, 'ok');
        return result;
      } catch (error) {
        recordInboxQuery(view, Math.round(performance.now() - startedAt), 'error');
        throw this.failure(error);
      }
    });
  }

  private failure(error: unknown): unknown {
    const translated = isStatementTimeout(error) ? new DatabaseUnavailableError(error) : error;
    if (!(translated instanceof ApiError) || translated.status >= 500) {
      this.logger.error(
        {
          event: 'inbox.query_failed',
          errorCode: translated instanceof ApiError ? translated.code : 'INTERNAL_ERROR',
          cause: error instanceof Error ? error.name : typeof error,
          correlationId: requireRequestContext().correlationId,
        },
        'inbox.query_failed',
      );
    }
    return translated;
  }
}

@Injectable()
export class GetTaskInboxHandler {
  constructor(
    @Inject(INBOX_TRANSACTIONS) private readonly transactions: InboxTransactions,
    @Inject(INBOX_READER) private readonly reader: InboxReader,
    @Inject(INBOX_CLOCK) private readonly clock: InboxClock,
    private readonly viewers: InboxViewerResolver,
    private readonly presenter: TaskInboxPresenter,
    private readonly instrumentation: InboxQueryInstrumentation,
  ) {}

  execute(query: TaskInboxQuery): Promise<TaskInboxResult> {
    return this.instrumentation.run(
      query.view,
      () => this.run(query),
      (result) => result.items.length,
    );
  }

  private run(query: TaskInboxQuery): Promise<TaskInboxResult> {
    return this.transactions.read(async (tx) => {
      const now = this.clock();
      const viewer = await this.viewers.resolveIn(tx, now);
      // FA-01: a fila de quem não se enquadra em RN-INBOX-04 é vazia (a aba não é exibida).
      const page =
        query.view === 'UNIT_QUEUE' && !unitQueueApplies(viewer)
          ? { rows: [], totalItems: 0 }
          : await this.reader.page(tx, {
              view: query.view,
              sort: query.sort,
              page: query.page,
              pageSize: query.pageSize,
              viewer,
              now,
            });
      const items = await this.presenter.present(tx, page.rows, viewer);
      return {
        items,
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          totalItems: page.totalItems,
          totalPages: Math.ceil(page.totalItems / query.pageSize),
        },
      };
    });
  }
}

@Injectable()
export class GetTaskInboxCountersHandler {
  constructor(
    @Inject(INBOX_TRANSACTIONS) private readonly transactions: InboxTransactions,
    @Inject(INBOX_READER) private readonly reader: InboxReader,
    @Inject(INBOX_CLOCK) private readonly clock: InboxClock,
    private readonly viewers: InboxViewerResolver,
    private readonly instrumentation: InboxQueryInstrumentation,
  ) {}

  execute(): Promise<TaskInboxCountersDto> {
    return this.instrumentation.run(
      'COUNTERS',
      () =>
        this.transactions.read(async (tx) => {
          const now = this.clock();
          const viewer = await this.viewers.resolveIn(tx, now);
          const counts = await this.reader.counts(tx, viewer, now);
          return {
            mine: counts.MINE,
            ...(unitQueueApplies(viewer) ? { unitQueue: counts.UNIT_QUEUE } : {}),
            pendingApprovals: counts.PENDING_APPROVALS,
            returned: counts.RETURNED,
            overdue: counts.OVERDUE,
            following: counts.FOLLOWING,
          };
        }),
      (counters) => Object.keys(counters).length,
    );
  }
}
