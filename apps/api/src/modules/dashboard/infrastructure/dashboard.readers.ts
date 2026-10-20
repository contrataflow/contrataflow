import type { ActorType, TimelineVisibility } from '@contrataflow/types';
import type { ProcessStatus } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { isProcessVisible } from '#shared/auth/process-access.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantTx } from '#shared/database/prisma.js';

import {
  buildAverageStageDurationsSql,
  buildCountByStageSql,
  buildCountByStatusSql,
  buildDeadlinesBySecretariatSql,
  buildOpenedByMonthSql,
  buildProcessCountsSql,
  buildRecentActivitySql,
  buildValueBySecretariatSql,
} from './dashboard.sql.js';
import type {
  DashboardActivity,
  DashboardReader,
  DashboardSearch,
  DashboardTransactions,
  KeyedCount,
} from '../application/ports.js';
import {
  averageStageDurations,
  canViewBudget,
  compareActivity,
  countBy,
  countByStatus,
  inScope,
  isActivityVisible,
  isDueSoon,
  isOpen,
  isOverdue,
  openedByMonth,
  processCounts,
  valueBySecretariat,
} from '../domain/dashboard.js';
import type {
  DashboardActivityRow,
  DashboardProcessCounts,
  DashboardProcessRow,
  DashboardStageRow,
  SecretariatValue,
  StageDuration,
} from '../domain/dashboard.js';

/** Teto de cada leitura do painel (RN-DASH-11: p95 < 1 s; acima disto, 503). */
export const DASHBOARD_STATEMENT_TIMEOUT_MS = 3000;

interface ActivityDbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly process_id: string;
  readonly occurred_at: Date;
  readonly type: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly actor_name: string | null;
  readonly actor_department_name: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly movement_id: string | null;
  readonly params: Record<string, unknown> | null;
  readonly visibility: string;
  readonly process_code: string | null;
}

function toActivity(row: ActivityDbRow): DashboardActivity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    processId: row.process_id,
    occurredAt: row.occurred_at,
    type: row.type,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorDepartmentName: row.actor_department_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    movementId: row.movement_id,
    params: row.params ?? {},
    visibility: row.visibility as TimelineVisibility,
    processCode: row.process_code,
  };
}

/** Leitura sobre PostgreSQL (RLS do tenant da transação), uma instrução por indicador. */
@Injectable()
export class PrismaDashboardReader implements DashboardReader {
  private async query<T>(tx: TenantTx, sql: Parameters<TenantTx['$queryRaw']>[0]): Promise<T[]> {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(DASHBOARD_STATEMENT_TIMEOUT_MS)}, true)`;
    return tx.$queryRaw<T[]>(sql);
  }

  async processCounts(tx: TenantTx, search: DashboardSearch): Promise<DashboardProcessCounts> {
    const [row] = await this.query<{ overdue: number; due_soon: number; open: number }>(
      tx,
      buildProcessCountsSql(search),
    );
    return { overdue: row?.overdue ?? 0, dueSoon: row?.due_soon ?? 0, open: row?.open ?? 0 };
  }

  async countByStatus(tx: TenantTx, search: DashboardSearch): Promise<Map<ProcessStatus, number>> {
    const rows = await this.query<KeyedCount>(tx, buildCountByStatusSql(search));
    return new Map(rows.map((row) => [row.key as ProcessStatus, row.value]));
  }

  countByStage(tx: TenantTx, search: DashboardSearch): Promise<KeyedCount[]> {
    return this.query<KeyedCount>(tx, buildCountByStageSql(search));
  }

  countDeadlinesBySecretariat(
    tx: TenantTx,
    search: DashboardSearch,
    kind: 'OVERDUE' | 'DUE_SOON',
  ): Promise<KeyedCount[]> {
    return this.query<KeyedCount>(tx, buildDeadlinesBySecretariatSql(search, kind));
  }

  async averageStageDurations(tx: TenantTx, search: DashboardSearch): Promise<StageDuration[]> {
    const rows = await this.query<{ key: string; average_seconds: number; sample_size: number }>(
      tx,
      buildAverageStageDurationsSql(search),
    );
    return rows.map((row) => ({
      workflowStageId: row.key,
      averageSeconds: row.average_seconds,
      sampleSize: row.sample_size,
    }));
  }

  openedByMonth(tx: TenantTx, search: DashboardSearch): Promise<KeyedCount[]> {
    return this.query<KeyedCount>(tx, buildOpenedByMonthSql(search));
  }

  async valueBySecretariat(tx: TenantTx, search: DashboardSearch): Promise<SecretariatValue[]> {
    const rows = await this.query<{ key: string; value: string; confidential_excluded: boolean }>(
      tx,
      buildValueBySecretariatSql(search),
    );
    return rows.map((row) => ({
      secretariatId: row.key,
      value: row.value,
      confidentialExcluded: row.confidential_excluded,
    }));
  }

  async recentActivity(
    tx: TenantTx,
    search: DashboardSearch,
    limit: number,
  ): Promise<DashboardActivity[]> {
    const rows = await this.query<ActivityDbRow>(tx, buildRecentActivitySql(search, limit));
    return rows.map(toActivity);
  }
}

/** Processo semeado no leitor em memória, com as concessões que o SQL leria de `process_access`. */
export type InMemoryDashboardProcess = DashboardProcessRow & {
  /** Usuários que veem o processo; ausente = segue o escopo de `PROCESS_VIEW` (órgão/tenant). */
  readonly visibleTo?: readonly string[];
  /** Unidades com `ProcessAccess` (padrão: solicitantes e atual). */
  readonly accessDepartmentIds?: readonly string[];
};

/**
 * Leitor em memória (modo de identidade fake, sem banco, e testes de rota): as linhas semeadas por
 * tenant e os predicados puros de `domain/dashboard.ts`. A visibilidade (DEC-024) é a de
 * `isProcessVisible` sobre as concessões semeadas (`accessDepartmentIds`) ou, com `visibleTo`, a
 * lista explícita de usuários.
 */
export class InMemoryDashboardReader implements DashboardReader {
  private readonly processes: InMemoryDashboardProcess[] = [];
  private readonly stages: DashboardStageRow[] = [];
  private readonly activity: DashboardActivityRow[] = [];
  /** Leituras feitas (o cenário de cache prova que o acerto não agrega de novo). */
  calls = 0;

  seed(input: {
    readonly processes?: readonly InMemoryDashboardProcess[];
    readonly stages?: readonly DashboardStageRow[];
    readonly activity?: readonly DashboardActivityRow[];
  }): void {
    this.processes.push(...(input.processes ?? []));
    this.stages.push(...(input.stages ?? []));
    this.activity.push(...(input.activity ?? []));
  }

  clear(): void {
    this.processes.length = 0;
    this.stages.length = 0;
    this.activity.length = 0;
    this.calls = 0;
  }

  processCounts(_tx: TenantTx, search: DashboardSearch): Promise<DashboardProcessCounts> {
    return Promise.resolve(processCounts(this.visible(search), search.window));
  }

  countByStatus(_tx: TenantTx, search: DashboardSearch): Promise<Map<ProcessStatus, number>> {
    const counts = countByStatus(this.visible(search));
    return Promise.resolve(
      new Map(
        (Object.entries(counts) as [ProcessStatus, number][]).filter(([, value]) => value > 0),
      ),
    );
  }

  countByStage(_tx: TenantTx, search: DashboardSearch): Promise<KeyedCount[]> {
    const rows = this.visible(search).filter(isOpen);
    return Promise.resolve(keyed(countBy(rows, (row) => row.currentWorkflowStageId)));
  }

  countDeadlinesBySecretariat(
    _tx: TenantTx,
    search: DashboardSearch,
    kind: 'OVERDUE' | 'DUE_SOON',
  ): Promise<KeyedCount[]> {
    const rows = this.visible(search).filter((row) =>
      kind === 'OVERDUE' ? isOverdue(row) : isDueSoon(row, search.window),
    );
    return Promise.resolve(keyed(countBy(rows, (row) => row.requestingSecretariatId)));
  }

  averageStageDurations(_tx: TenantTx, search: DashboardSearch): Promise<StageDuration[]> {
    const visible = new Set(this.visible(search).map((row) => row.id));
    const stages = this.inTenant(this.stages).filter((stage) => visible.has(stage.processId));
    return Promise.resolve(averageStageDurations(stages, search.window));
  }

  openedByMonth(_tx: TenantTx, search: DashboardSearch): Promise<KeyedCount[]> {
    const counts = openedByMonth(this.visible(search), search.window);
    return Promise.resolve(keyed(counts).filter((entry) => entry.value > 0));
  }

  valueBySecretariat(_tx: TenantTx, search: DashboardSearch): Promise<SecretariatValue[]> {
    return Promise.resolve(
      valueBySecretariat(this.visible(search), (row) =>
        canViewBudget(row, search.viewer.budget, this.grantsOf(row)),
      ),
    );
  }

  recentActivity(
    _tx: TenantTx,
    search: DashboardSearch,
    limit: number,
  ): Promise<DashboardActivity[]> {
    const byId = new Map(this.visible(search).map((row) => [row.id, row]));
    const entries = this.inTenant(this.activity).flatMap((entry) => {
      const process = byId.get(entry.processId);
      if (process === undefined) return [];
      const restricted = canViewBudget(process, search.viewer.budget, this.grantsOf(process), true);
      return isActivityVisible(entry, restricted) ? [{ ...entry, processCode: process.code }] : [];
    });
    return Promise.resolve(entries.sort(compareActivity).slice(0, limit));
  }

  private inTenant<T extends { readonly tenantId: string }>(rows: readonly T[]): T[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    return rows.filter((row) => row.tenantId === tenantId);
  }

  private grantsOf(row: InMemoryDashboardProcess): readonly string[] {
    return (
      row.accessDepartmentIds ?? [
        row.requestingSecretariatId,
        row.requestingDepartmentId,
        row.currentDepartmentId,
      ]
    );
  }

  private visible(search: DashboardSearch): InMemoryDashboardProcess[] {
    this.calls += 1;
    const { visibility } = search.viewer;
    return this.inTenant(this.processes).filter(
      (row) =>
        (row.visibleTo === undefined
          ? isProcessVisible(visibility, {
              organizationId: row.organizationId,
              departmentIds: this.grantsOf(row),
              userIds: [],
            })
          : row.visibleTo.includes(search.viewer.userId)) && inScope(row, search.scope),
    );
  }
}

function keyed(counts: ReadonlyMap<string, number>): KeyedCount[] {
  return [...counts].map(([key, value]) => ({ key, value }));
}

/** Leitura na `TenantTransaction` (RLS do tenant). */
@Injectable()
export class PrismaDashboardTransactions implements DashboardTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

/** Modo de identidade fake (sem banco): transação simulada, como os demais módulos. */
export class InMemoryDashboardTransactions implements DashboardTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
