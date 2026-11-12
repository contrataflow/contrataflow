import type { ApprovalListLine, ApprovalListRow } from '#modules/approval/domain/approval-list.js';

/*
 * Tokens do módulo `approval` para os testes de rota que atravessam módulos (US-052): a decisão
 * corre nas transações e no relógio do `approval`, substituídos pelo teste (fila, banco fora).
 */
export { APPROVAL_CLOCK, APPROVAL_TRANSACTIONS } from '#modules/approval/application/ports.js';
export type { ApprovalTransactions } from '#modules/approval/application/ports.js';

/**
 * US-136: a linha de backfill (M2-03) de uma `ApprovalListRow` do MVP 1 — `sequence` 1, o
 * aprovador espelhado e o estado da aprovação.
 */
export function mirrorListLineOf(
  row: Omit<ApprovalListRow, 'lines' | 'decisionPolicy'>,
  lineId: string,
): ApprovalListLine {
  return {
    id: lineId,
    sequence: 1,
    status: row.status,
    approverType: row.approverType,
    approverUserId: row.approverUserId,
    approverRoleId: row.approverRoleId,
    approverDepartmentId: row.approverDepartmentId,
    allowDeputy: row.allowDeputy,
    decidedById: row.status === 'PENDING' || row.status === 'CANCELED' ? null : row.decidedById,
    skippedReason: null,
  };
}

/**
 * US-136 (PostgreSQL): grava a linha `sequence` 1 espelhando a aprovação `$1` (como o backfill
 * M2-03) — para os testes que inserem `approvals` direto no banco. Rodar como `db.admin`.
 */
export const MIRROR_APPROVAL_LINE_SQL = `
  INSERT INTO approval_approvers (id, tenant_id, approval_id, sequence, approver_type,
                                  approver_user_id, approver_role_id, approver_department_id,
                                  allow_deputy, status, activated_at, due_at, decision,
                                  decided_by_id, decided_at)
  SELECT gen_random_uuid(), a.tenant_id, a.id, 1, a.approver_type, a.approver_user_id,
         a.approver_role_id, a.approver_department_id, a.allow_deputy,
         a.status::text::approval_approver_status, a.requested_at, NULL, a.decision,
         a.decided_by_id, a.decided_at
    FROM approvals a WHERE a.id = $1`;

/** US-136 (PostgreSQL): leva à linha espelhada a decisão gravada na aprovação `$1`. */
export const SYNC_APPROVAL_LINE_SQL = `
  UPDATE approval_approvers l
     SET status = a.status::text::approval_approver_status, decision = a.decision,
         decided_by_id = a.decided_by_id, decided_at = a.decided_at, version = l.version + 1
    FROM approvals a
   WHERE a.id = $1 AND l.approval_id = a.id AND l.sequence = 1`;
