import {
  DASHBOARD_AVG_STAGE_WINDOW_DAYS,
  DASHBOARD_RECENT_ACTIVITY_LIMITS,
  PROCESS_STATUSES,
  TASK_INBOX_VIEWS,
} from '@contrataflow/validation';
import type {
  DashboardWidgetDto,
  DashboardWidgetKey,
  DashboardWidgetOf,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { DASHBOARD_READER } from './ports.js';
import type { DashboardReader, DashboardSearch, KeyedCount } from './ports.js';
import { InboxFacade } from '../../inbox/application/inbox.facade.js';
import type { InboxCountersSnapshot } from '../../inbox/application/inbox.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { openedByMonth } from '../domain/dashboard.js';

/*
 * `DashboardWidgetRegistry` (US-076 · RN-DASH-02): um resolvedor por `DashboardWidgetKey`. Cada um
 * faz UMA leitura agregada (`DashboardReader`) e resolve os nomes por lote (etapas pelo `workflow`,
 * secretarias pela `organization`) — nunca N+1. `PENDING_ITEMS` reaproveita os contadores de
 * TSK-02 pela `InboxFacade` (RN-DASH-03).
 */

export interface WidgetRequest {
  readonly tx: TenantTx;
  readonly search: DashboardSearch;
  /** Só `RECENT_ACTIVITY` (RN-DASH-08). */
  readonly limit: number;
  readonly generatedAt: string;
}

type Resolver<K extends DashboardWidgetKey> = (
  request: WidgetRequest,
) => Promise<DashboardWidgetOf<K>>;

/** Pendências de quem consulta: "Comigo" + "Aprovações pendentes" de TSK-02. */
export function pendingCountOf(snapshot: InboxCountersSnapshot): number {
  return snapshot.counts.MINE + snapshot.counts.PENDING_APPROVALS;
}

const sum = (series: readonly { readonly value: number }[]) =>
  series.reduce((total, item) => total + item.value, 0);

@Injectable()
export class DashboardWidgetRegistry {
  private readonly resolvers: { readonly [K in DashboardWidgetKey]: Resolver<K> } = {
    PENDING_ITEMS: (request) => this.pendingItems(request),
    BY_STATUS: (request) => this.byStatus(request),
    BY_STAGE: (request) => this.byStage(request),
    OVERDUE: (request) => this.overdue(request),
    DUE_SOON: (request) => this.dueSoon(request),
    AVG_STAGE_DURATION: (request) => this.averageStageDuration(request),
    OPENED_BY_MONTH: (request) => this.openedByMonth(request),
    VALUE_BY_SECRETARIAT: (request) => this.valueBySecretariat(request),
    RECENT_ACTIVITY: (request) => this.recentActivity(request),
  };

  constructor(
    @Inject(DASHBOARD_READER) private readonly reader: DashboardReader,
    private readonly inbox: InboxFacade,
    private readonly workflow: WorkflowFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  resolve(key: DashboardWidgetKey, request: WidgetRequest): Promise<DashboardWidgetDto> {
    return (this.resolvers[key] as Resolver<DashboardWidgetKey>)(request);
  }

  /** O snapshot de TSK-02 com o recorte dos filtros (também o `pendingCount` de DSH-01). */
  inboxCounters(tx: TenantTx, search: DashboardSearch): Promise<InboxCountersSnapshot> {
    return this.inbox.countersIn(tx, search.window.now, search.scope);
  }

  private async pendingItems(request: WidgetRequest): Promise<DashboardWidgetOf<'PENDING_ITEMS'>> {
    const snapshot = await this.inboxCounters(request.tx, request.search);
    const series = TASK_INBOX_VIEWS.filter(
      (view) => view !== 'UNIT_QUEUE' || snapshot.unitQueueApplies,
    ).map((view) => ({ key: view, label: null, value: snapshot.counts[view] }));
    return {
      widgetKey: 'PENDING_ITEMS',
      total: pendingCountOf(snapshot),
      series,
      generatedAt: request.generatedAt,
    };
  }

  private async byStatus(request: WidgetRequest): Promise<DashboardWidgetOf<'BY_STATUS'>> {
    const counts = await this.reader.countByStatus(request.tx, request.search);
    const series = PROCESS_STATUSES.map((status) => ({
      key: status,
      label: null,
      value: counts.get(status) ?? 0,
    }));
    return { widgetKey: 'BY_STATUS', total: sum(series), series, generatedAt: request.generatedAt };
  }

  private async byStage(request: WidgetRequest): Promise<DashboardWidgetOf<'BY_STAGE'>> {
    const counts = await this.reader.countByStage(request.tx, request.search);
    const series = await this.withStageNames(request.tx, counts);
    return {
      widgetKey: 'BY_STAGE',
      total: sum(series),
      series: series.map(({ key, label, value }) => ({ key, label, value })),
      generatedAt: request.generatedAt,
    };
  }

  private async overdue(request: WidgetRequest): Promise<DashboardWidgetOf<'OVERDUE'>> {
    const series = await this.deadlineSeries(request, 'OVERDUE');
    return { widgetKey: 'OVERDUE', total: sum(series), series, generatedAt: request.generatedAt };
  }

  private async dueSoon(request: WidgetRequest): Promise<DashboardWidgetOf<'DUE_SOON'>> {
    const series = await this.deadlineSeries(request, 'DUE_SOON');
    return {
      widgetKey: 'DUE_SOON',
      total: sum(series),
      warnBeforeBusinessDays: request.search.window.warnBeforeBusinessDays,
      series,
      generatedAt: request.generatedAt,
    };
  }

  /** `OVERDUE`/`DUE_SOON` por secretaria solicitante (RN-DASH-04). */
  private async deadlineSeries(request: WidgetRequest, kind: 'OVERDUE' | 'DUE_SOON') {
    const counts = await this.reader.countDeadlinesBySecretariat(request.tx, request.search, kind);
    return this.withSecretariatNames(request.tx, counts);
  }

  private async averageStageDuration(
    request: WidgetRequest,
  ): Promise<DashboardWidgetOf<'AVG_STAGE_DURATION'>> {
    const durations = await this.reader.averageStageDurations(request.tx, request.search);
    const named = await this.withStageNames(
      request.tx,
      durations.map((duration) => ({ key: duration.workflowStageId, value: duration.sampleSize })),
    );
    const byStage = new Map(durations.map((duration) => [duration.workflowStageId, duration]));
    return {
      widgetKey: 'AVG_STAGE_DURATION',
      windowDays: DASHBOARD_AVG_STAGE_WINDOW_DAYS,
      series: named.map(({ key, label }) => ({
        key,
        label,
        value: byStage.get(key)?.averageSeconds ?? 0,
        sampleSize: byStage.get(key)?.sampleSize ?? 1,
      })),
      generatedAt: request.generatedAt,
    };
  }

  private async openedByMonth(
    request: WidgetRequest,
  ): Promise<DashboardWidgetOf<'OPENED_BY_MONTH'>> {
    const counts = new Map(
      (await this.reader.openedByMonth(request.tx, request.search)).map((row) => [
        row.key,
        row.value,
      ]),
    );
    // Zero nos meses sem autuação; meses fora da janela são ignorados (mesma regra do domínio).
    const filled = openedByMonth([], request.search.window);
    const series = [...filled.keys()].map((month) => ({
      key: month,
      label: null,
      value: counts.get(month) ?? 0,
    }));
    return {
      widgetKey: 'OPENED_BY_MONTH',
      total: sum(series),
      series,
      generatedAt: request.generatedAt,
    };
  }

  private async valueBySecretariat(
    request: WidgetRequest,
  ): Promise<DashboardWidgetOf<'VALUE_BY_SECRETARIAT'>> {
    const values = await this.reader.valueBySecretariat(request.tx, request.search);
    const names = await this.organization.departmentNames(
      request.tx,
      values.map((value) => value.secretariatId),
    );
    const series = values
      .map((value) => ({
        key: value.secretariatId,
        label: names.get(value.secretariatId) ?? null,
        value: value.value,
        confidentialExcluded: value.confidentialExcluded,
      }))
      .sort(byLabel);
    return { widgetKey: 'VALUE_BY_SECRETARIAT', series, generatedAt: request.generatedAt };
  }

  private async recentActivity(
    request: WidgetRequest,
  ): Promise<DashboardWidgetOf<'RECENT_ACTIVITY'>> {
    const limit = Math.min(
      Math.max(request.limit, DASHBOARD_RECENT_ACTIVITY_LIMITS.min),
      DASHBOARD_RECENT_ACTIVITY_LIMITS.max,
    );
    const entries = await this.reader.recentActivity(request.tx, request.search, limit);
    return {
      widgetKey: 'RECENT_ACTIVITY',
      items: entries.map((entry) => ({
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
        process: { id: entry.processId, code: entry.processCode },
      })),
      generatedAt: request.generatedAt,
    };
  }

  /** Nomes das etapas (versões publicadas e aposentadas), na ordem de exibição do workflow. */
  private async withStageNames(
    tx: TenantTx,
    counts: readonly KeyedCount[],
  ): Promise<{ key: string; label: string | null; value: number }[]> {
    if (counts.length === 0) return [];
    const stages = new Map((await this.workflow.releasedStages(tx)).map((s) => [s.id, s]));
    return counts
      .map((count) => ({ ...count, stage: stages.get(count.key) }))
      .sort(
        (a, b) =>
          (a.stage?.displayOrder ?? Number.MAX_SAFE_INTEGER) -
            (b.stage?.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
          (a.stage?.name ?? '').localeCompare(b.stage?.name ?? '', 'pt-BR') ||
          a.key.localeCompare(b.key),
      )
      .map(({ key, value, stage }) => ({ key, label: stage?.name ?? null, value }));
  }

  /** Nomes das secretarias, em ordem alfabética. */
  private async withSecretariatNames(
    tx: TenantTx,
    counts: readonly KeyedCount[],
  ): Promise<{ key: string; label: string | null; value: number }[]> {
    if (counts.length === 0) return [];
    const names = await this.organization.departmentNames(
      tx,
      counts.map((count) => count.key),
    );
    return counts
      .map(({ key, value }) => ({ key, label: names.get(key) ?? null, value }))
      .sort(byLabel);
  }
}

function byLabel(
  a: { readonly key: string; readonly label: string | null },
  b: { readonly key: string; readonly label: string | null },
): number {
  return (a.label ?? '').localeCompare(b.label ?? '', 'pt-BR') || a.key.localeCompare(b.key);
}
