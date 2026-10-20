import { TASK_INBOX_VIEWS } from '@contrataflow/validation';
import type { ApprovalSubjectType, DayCountType, ProcessStatus } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { buildTaskInboxCountsSql, buildTaskInboxPageSql } from './task-inbox.sql.js';
import type { TaskInboxDbRow } from './task-inbox.sql.js';
import type {
  InboxCounts,
  InboxPage,
  InboxPageSearch,
  InboxReader,
  InboxTransactions,
} from '../application/ports.js';
import { compareItems, itemsOfView, matchesRestriction } from '../domain/task-inbox.js';
import type {
  InboxApprovalRow,
  InboxApproverType,
  InboxItemRow,
  InboxParticipationRow,
  InboxProcessRestriction,
  InboxProcessRow,
  InboxViewer,
} from '../domain/task-inbox.js';

/** Teto de cada leitura da caixa (polling de 60 s de todos os usuários — RN-INBOX-12/13). */
export const INBOX_STATEMENT_TIMEOUT_MS = 3000;

function toProcessRow(row: Omit<TaskInboxDbRow, 'total'>): InboxProcessRow {
  return {
    tenantId: row.tenant_id,
    id: row.process_id,
    organizationId: row.organization_id,
    code: row.code,
    number: row.number,
    year: row.year,
    title: row.title,
    status: row.status as ProcessStatus,
    version: row.version,
    isBudgetConfidential: row.is_budget_confidential,
    requestingSecretariatId: row.requesting_secretariat_id,
    requestingDepartmentId: row.requesting_department_id,
    currentDepartmentId: row.current_department_id,
    currentResponsibleId: row.current_responsible_id,
    currentWorkflowStageId: row.current_workflow_stage_id,
    stageId: row.stage_id,
    enteredAt: row.entered_at,
    dueAt: row.due_at,
    overdueSince: row.overdue_since,
    slaType: row.sla_type as DayCountType | null,
    pausedAt: row.paused_at,
    assignmentDepartmentId: row.assignment_department_id,
    assigneeId: row.assignee_id,
    assignmentType: row.assignment_type,
  };
}

function toApprovalRow(row: Omit<TaskInboxDbRow, 'total'>): InboxApprovalRow | null {
  if (row.approval_id === null || row.approval_requested_at === null) return null;
  return {
    tenantId: row.tenant_id,
    id: row.approval_id,
    processId: row.process_id,
    subjectType: row.approval_subject_type as ApprovalSubjectType,
    title: row.approval_title ?? '',
    requestedById: row.approval_requested_by_id ?? '',
    requestedAt: row.approval_requested_at,
    dueAt: row.approval_due_at,
    approverType: row.approver_type as InboxApproverType,
    approverUserId: row.approver_user_id,
    approverRoleId: row.approver_role_id,
    approverDepartmentId: row.approver_department_id,
    allowDeputy: row.allow_deputy ?? false,
  };
}

/** Leitura sobre PostgreSQL (views publicadas, RLS do tenant da transação). */
@Injectable()
export class PrismaInboxReader implements InboxReader {
  async page(tx: TenantTx, search: InboxPageSearch): Promise<InboxPage> {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(INBOX_STATEMENT_TIMEOUT_MS)}, true)`;
    const rows = await tx.$queryRaw<TaskInboxDbRow[]>(buildTaskInboxPageSql(search));
    return {
      totalItems: rows[0]?.total ?? 0,
      rows: rows.flatMap((row) =>
        row.row_key === null
          ? []
          : [{ key: row.row_key, process: toProcessRow(row), approval: toApprovalRow(row) }],
      ),
    };
  }

  async counts(
    tx: TenantTx,
    viewer: InboxViewer,
    now: Date,
    restriction: InboxProcessRestriction | null = null,
  ): Promise<InboxCounts> {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(INBOX_STATEMENT_TIMEOUT_MS)}, true)`;
    const [row] = await tx.$queryRaw<Record<string, number>[]>(
      buildTaskInboxCountsSql(viewer, now, restriction),
    );
    const count = (key: string) => row?.[key] ?? 0;
    return {
      MINE: count('MINE'),
      UNIT_QUEUE: count('UNIT_QUEUE'),
      PENDING_APPROVALS: count('PENDING_APPROVALS'),
      RETURNED: count('RETURNED'),
      OVERDUE: count('OVERDUE'),
      FOLLOWING: count('FOLLOWING'),
    };
  }
}

/**
 * Leitor em memória (modo de identidade fake, sem banco, e testes de rota): as linhas das views
 * semeadas por tenant e os predicados puros de `domain/task-inbox.ts`. A visibilidade (DEC-024) é a
 * do conjunto semeado — `visibleTo` restringe uma linha a usuários específicos.
 */
export class InMemoryInboxReader implements InboxReader {
  private readonly processes: (InboxProcessRow & { readonly visibleTo?: readonly string[] })[] = [];
  private readonly approvals: InboxApprovalRow[] = [];
  private readonly participations: InboxParticipationRow[] = [];

  seed(input: {
    readonly processes?: readonly (InboxProcessRow & { readonly visibleTo?: readonly string[] })[];
    readonly approvals?: readonly InboxApprovalRow[];
    readonly participations?: readonly InboxParticipationRow[];
  }): void {
    this.processes.push(...(input.processes ?? []));
    this.approvals.push(...(input.approvals ?? []));
    this.participations.push(...(input.participations ?? []));
  }

  /** Troca a linha do processo (ex.: depois de "Assumir"). */
  replaceProcess(row: InboxProcessRow): void {
    const index = this.processes.findIndex(
      (process) => process.tenantId === row.tenantId && process.id === row.id,
    );
    if (index >= 0) this.processes[index] = { ...this.processes[index], ...row };
  }

  clear(): void {
    this.processes.length = 0;
    this.approvals.length = 0;
    this.participations.length = 0;
  }

  page(_tx: TenantTx, search: InboxPageSearch): Promise<InboxPage> {
    const items = this.items(search.view, search.viewer, search.now).sort(
      compareItems(search.sort),
    );
    const start = (search.page - 1) * search.pageSize;
    return Promise.resolve({
      rows: items.slice(start, start + search.pageSize),
      totalItems: items.length,
    });
  }

  counts(
    _tx: TenantTx,
    viewer: InboxViewer,
    now: Date,
    restriction: InboxProcessRestriction | null = null,
  ): Promise<InboxCounts> {
    const counts = Object.fromEntries(
      TASK_INBOX_VIEWS.map((view) => [view, this.items(view, viewer, now, restriction).length]),
    ) as Record<(typeof TASK_INBOX_VIEWS)[number], number>;
    return Promise.resolve(counts);
  }

  private items(
    view: InboxPageSearch['view'],
    viewer: InboxViewer,
    now: Date,
    restriction: InboxProcessRestriction | null = null,
  ): InboxItemRow[] {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const inTenant = <T extends { readonly tenantId: string }>(rows: readonly T[]) =>
      rows.filter((row) => row.tenantId === tenantId);
    const processes = inTenant(this.processes).filter(
      (row) =>
        (row.visibleTo === undefined || row.visibleTo.includes(viewer.userId)) &&
        matchesRestriction(row, restriction),
    );
    return itemsOfView(
      view,
      {
        processes,
        approvals: inTenant(this.approvals),
        participations: inTenant(this.participations),
      },
      viewer,
      now,
    );
  }
}

/** Leitura na `TenantTransaction` (RLS do tenant). */
@Injectable()
export class PrismaInboxTransactions implements InboxTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

/** Modo de identidade fake (sem banco): transação simulada, como os demais módulos. */
export class InMemoryInboxTransactions implements InboxTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
