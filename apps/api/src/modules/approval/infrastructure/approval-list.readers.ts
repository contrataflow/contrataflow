import type {
  ApprovalApproverStatus,
  ApprovalDecisionPolicy,
  ApprovalSkippedReason,
  ApprovalStatus,
  ApprovalSubjectType,
  ApproverType,
} from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { buildApprovalListPageSql } from './approval-list.sql.js';
import type { ApprovalListDbRow } from './approval-list.sql.js';
import type {
  ApprovalListPage,
  ApprovalListReader,
  ApprovalListSearch,
} from '../application/ports.js';
import {
  compareApprovalRows,
  isInApprovalList,
  matchesCriteria,
  myLineOf,
} from '../domain/approval-list.js';
import type {
  ApprovalListLine,
  ApprovalListMyLine,
  ApprovalListRow,
} from '../domain/approval-list.js';

/** Teto de cada leitura da lista (story US-057 · p95 < 400 ms; acima disto, 503). */
export const APPROVAL_LIST_STATEMENT_TIMEOUT_MS = 3000;

function toRow(
  row: ApprovalListDbRow & { readonly id: string },
  lines: readonly ApprovalListLine[],
): ApprovalListRow & { readonly myLine: ApprovalListMyLine | null } {
  return {
    decisionPolicy: row.decision_policy as ApprovalDecisionPolicy,
    lines,
    myLine:
      row.my_line_id === null
        ? null
        : {
            id: row.my_line_id,
            sequence: row.my_line_sequence ?? 1,
            status: row.my_line_status as ApprovalApproverStatus,
          },
    tenantId: row.tenant_id,
    id: row.id,
    processId: row.process_id,
    subjectType: row.subject_type as ApprovalSubjectType,
    title: row.title,
    documentId: row.document_id,
    status: row.status as ApprovalStatus,
    requestedById: row.requested_by_id,
    requestedAt: row.requested_at,
    dueAt: row.due_at,
    approverType: row.approver_type as ApproverType,
    approverUserId: row.approver_user_id,
    approverRoleId: row.approver_role_id,
    approverDepartmentId: row.approver_department_id,
    allowDeputy: row.allow_deputy,
    decidedById: row.decided_by_id,
    process: {
      code: row.code,
      number: row.number,
      year: row.year,
      title: row.process_title,
      organizationId: row.organization_id,
      requestingSecretariatId: row.requesting_secretariat_id,
      requestingDepartmentId: row.requesting_department_id,
      isBudgetConfidential: row.is_budget_confidential,
    },
  };
}

/** Leitura sobre PostgreSQL (RLS do tenant da transação; a view é `security_invoker`). */
@Injectable()
export class PrismaApprovalListReader implements ApprovalListReader {
  async page(tx: TenantTx, search: ApprovalListSearch): Promise<ApprovalListPage> {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(APPROVAL_LIST_STATEMENT_TIMEOUT_MS)}, true)`;
    const rows = await tx.$queryRaw<ApprovalListDbRow[]>(buildApprovalListPageSql(search));
    const ids = rows.flatMap((row) => (row.id === null ? [] : [row.id]));
    // US-136: as linhas das aprovações da página (andamento e aprovador atual), numa leitura.
    const lines =
      ids.length === 0
        ? []
        : await tx.approvalApprover.findMany({
            where: { approvalId: { in: ids } },
            orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          });
    const linesOf = new Map<string, ApprovalListLine[]>();
    for (const line of lines) {
      const list = linesOf.get(line.approvalId) ?? [];
      list.push({
        id: line.id,
        sequence: line.sequence,
        status: line.status,
        approverType: line.approverType,
        approverUserId: line.approverUserId,
        approverRoleId: line.approverRoleId,
        approverDepartmentId: line.approverDepartmentId,
        allowDeputy: line.allowDeputy,
        decidedById: line.decidedById,
        skippedReason: line.skippedReason as ApprovalSkippedReason | null,
      });
      linesOf.set(line.approvalId, list);
    }
    return {
      totalItems: rows[0]?.total ?? 0,
      rows: rows.flatMap((row) =>
        row.id === null ? [] : [toRow({ ...row, id: row.id }, linesOf.get(row.id) ?? [])],
      ),
    };
  }
}

/**
 * Leitor em memória (modo de identidade fake, sem banco, e testes de rota): as linhas semeadas por
 * tenant e os predicados puros de `domain/approval-list.ts`.
 */
export class InMemoryApprovalListReader implements ApprovalListReader {
  private readonly rows: ApprovalListRow[] = [];

  seed(rows: readonly ApprovalListRow[]): void {
    this.rows.push(...rows);
  }

  /** Troca a linha (ex.: decidida por outra pessoa enquanto a lista estava aberta). */
  replace(row: ApprovalListRow): void {
    const index = this.rows.findIndex(
      (current) => current.tenantId === row.tenantId && current.id === row.id,
    );
    if (index >= 0) this.rows[index] = row;
  }

  clear(): void {
    this.rows.length = 0;
  }

  page(_tx: TenantTx, search: ApprovalListSearch): Promise<ApprovalListPage> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    const items = this.rows
      .filter((row) => row.tenantId === tenantId && isInApprovalList(row, search.coverage))
      .map((row) => ({ ...row, myLine: myLineOf(row, search.coverage) }))
      .filter((row) => matchesCriteria(row, search.criteria, row.myLine))
      .sort(compareApprovalRows(search.sort));
    const start = (search.page - 1) * search.pageSize;
    return Promise.resolve({
      rows: items.slice(start, start + search.pageSize),
      totalItems: items.length,
    });
  }
}
