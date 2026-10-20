import { withSpan } from '@contrataflow/observability';
import {
  DASHBOARD_RECENT_ACTIVITY_LIMITS,
  DASHBOARD_MESSAGES,
  dashboardSummarySchema,
  dashboardWidgetSchema,
  isDashboardWidgetKey,
} from '@contrataflow/validation';
import type {
  DashboardCacheMeta,
  DashboardFilters,
  DashboardSummaryDto,
  DashboardWidgetDto,
  DashboardWidgetKey,
  DashboardWidgetQuery,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';

import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isStatementTimeout } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { DashboardCache, dashboardCacheKey } from './dashboard-cache.js';
import { DashboardContextResolver } from './dashboard-context.resolver.js';
import { recordDashboardWidget } from './dashboard-telemetry.js';
import { DashboardWidgetRegistry, pendingCountOf } from './dashboard-widgets.js';
import { DASHBOARD_CLOCK, DASHBOARD_READER, DASHBOARD_TRANSACTIONS } from './ports.js';
import type {
  DashboardClock,
  DashboardReader,
  DashboardSearch,
  DashboardTransactions,
} from './ports.js';

/*
 * `GetDashboardSummaryHandler` (DSH-01) e `GetDashboardWidgetHandler` (DSH-02) — US-076: leituras
 * puras (sem evento nem auditoria — mesma convenção de TSK-01/02) na transação de leitura do
 * tenant, com `DASHBOARD_VIEW` já conferido pela rota. Ordem: filtros validados (422 antes de
 * qualquer agregação) → cache (60 s, RN-DASH-10) → agregação. Logs sem valores monetários nem
 * títulos de processo (story · "Logs").
 */

/** RN-DASH-11: p95 < 1 s; acima disto, `warn dashboard.widget_slow`. */
export const DASHBOARD_SLOW_WIDGET_MS = 800;

const SUMMARY = 'SUMMARY';

export interface DashboardResult<T> {
  readonly data: T;
  readonly cache: DashboardCacheMeta;
}

/** Logs, métrica e tradução de falhas comuns ao resumo e aos indicadores. */
@Injectable()
export class DashboardQueryInstrumentation {
  private readonly logger = new Logger('Dashboard');

  async run<T>(
    widget: string,
    work: () => Promise<DashboardResult<T>>,
  ): Promise<DashboardResult<T>> {
    return withSpan('dashboard.widget', { 'cf.dashboard.widget': widget }, async () => {
      const startedAt = performance.now();
      try {
        const result = await work();
        const durationMs = Math.round(performance.now() - startedAt);
        const context = requireRequestContext();
        const fields = {
          widgetKey: widget,
          tenantId: context.tenantId,
          userId: context.actor.userId,
          durationMs,
          cacheHit: result.cache.hit,
          correlationId: context.correlationId,
        };
        this.logger.log({ event: 'dashboard.widget_served', ...fields }, 'dashboard.widget_served');
        if (durationMs > DASHBOARD_SLOW_WIDGET_MS) {
          this.logger.warn({ event: 'dashboard.widget_slow', ...fields }, 'dashboard.widget_slow');
        }
        recordDashboardWidget(widget, durationMs, 'ok', result.cache.hit);
        return result;
      } catch (error) {
        recordDashboardWidget(widget, Math.round(performance.now() - startedAt), 'error', false);
        throw this.failure(widget, error);
      }
    });
  }

  private failure(widget: string, error: unknown): unknown {
    const translated = isStatementTimeout(error) ? new DatabaseUnavailableError(error) : error;
    if (!(translated instanceof ApiError) || translated.status >= 500) {
      this.logger.error(
        {
          event: 'dashboard.widget_failed',
          widgetKey: widget,
          errorCode: translated instanceof ApiError ? translated.code : 'INTERNAL_ERROR',
          cause: error instanceof Error ? error.name : typeof error,
          correlationId: requireRequestContext().correlationId,
        },
        'dashboard.widget_failed',
      );
    }
    return translated;
  }
}

/** O que os dois handlers compartilham: filtros, cache e a montagem da consulta agregada. */
@Injectable()
export class DashboardQuerySupport {
  constructor(
    @Inject(DASHBOARD_TRANSACTIONS) private readonly transactions: DashboardTransactions,
    @Inject(DASHBOARD_CLOCK) private readonly clock: DashboardClock,
    private readonly context: DashboardContextResolver,
    private readonly cache: DashboardCache,
  ) {}

  /**
   * Valida os filtros, procura no cache e, na ausência, agrega (`compute`) e grava. O acerto não
   * toca nas tabelas agregadas (cenário [Duplicidade]).
   */
  serve<T>(
    widget: string,
    filters: DashboardFilters & { readonly limit?: number | undefined },
    schema: z.ZodType<T>,
    compute: (tx: TenantTx, search: DashboardSearch, generatedAt: string) => Promise<T>,
  ): Promise<DashboardResult<T>> {
    return this.transactions.read(async (tx) => {
      const scope = await this.context.scopeOf(tx, filters);
      const userId = requireRequestContext().actor.userId;
      if (userId === null) throw new ApiError('UNAUTHENTICATED');
      const key = dashboardCacheKey({ userId, widget, ...filters });
      const cached = await this.cache.read<T>(widget, key, schema);
      if (cached !== null) {
        return { data: cached.value, cache: { hit: true, expiresAt: cached.expiresAt } };
      }
      const now = this.clock();
      // Em sequência: a transação interativa executa uma consulta por vez.
      const viewer = await this.context.viewerIn(tx);
      const window = await this.context.windowIn(tx, now);
      const data = await compute(tx, { viewer, scope, window }, now.toISOString());
      const expiresAt = await this.cache.write(widget, key, data, now);
      return { data, cache: { hit: false, expiresAt } };
    });
  }
}

@Injectable()
export class GetDashboardSummaryHandler {
  constructor(
    @Inject(DASHBOARD_READER) private readonly reader: DashboardReader,
    private readonly widgets: DashboardWidgetRegistry,
    private readonly support: DashboardQuerySupport,
    private readonly instrumentation: DashboardQueryInstrumentation,
  ) {}

  execute(filters: DashboardFilters): Promise<DashboardResult<DashboardSummaryDto>> {
    return this.instrumentation.run(SUMMARY, () =>
      this.support.serve(SUMMARY, filters, dashboardSummarySchema, async (tx, search, at) => {
        const inbox = await this.widgets.inboxCounters(tx, search);
        const counts = await this.reader.processCounts(tx, search);
        return {
          pendingCount: pendingCountOf(inbox),
          overdueCount: counts.overdue,
          dueSoonCount: counts.dueSoon,
          openCount: counts.open,
          generatedAt: at,
        };
      }),
    );
  }
}

@Injectable()
export class GetDashboardWidgetHandler {
  constructor(
    private readonly widgets: DashboardWidgetRegistry,
    private readonly support: DashboardQuerySupport,
    private readonly instrumentation: DashboardQueryInstrumentation,
  ) {}

  /** @throws ApiError 404 `WIDGET_NOT_FOUND` fora do registro (V-01), antes de qualquer leitura. */
  execute(
    widgetKey: string,
    query: DashboardWidgetQuery,
  ): Promise<DashboardResult<DashboardWidgetDto>> {
    if (!isDashboardWidgetKey(widgetKey)) {
      throw new ApiError('WIDGET_NOT_FOUND', { detail: DASHBOARD_MESSAGES.widgetNotFound });
    }
    const key: DashboardWidgetKey = widgetKey;
    const limit =
      key === 'RECENT_ACTIVITY'
        ? (query.limit ?? DASHBOARD_RECENT_ACTIVITY_LIMITS.default)
        : undefined;
    const filters = {
      secretariatId: query.secretariatId,
      departmentId: query.departmentId,
      limit,
    };
    return this.instrumentation.run(key, () =>
      this.support.serve(key, filters, dashboardWidgetSchema, (tx, search, generatedAt) =>
        this.widgets.resolve(key, {
          tx,
          search,
          limit: limit ?? DASHBOARD_RECENT_ACTIVITY_LIMITS.default,
          generatedAt,
        }),
      ),
    );
  }
}
