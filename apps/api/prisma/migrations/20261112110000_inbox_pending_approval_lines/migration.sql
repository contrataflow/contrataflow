-- US-136 · RN-APV-61..64 (aprovação múltipla na caixa de tarefas — entities.md MVP 2 §4.6/§10, M2-03,
-- DEC-193): a view `v_inbox_pending_approvals` v2, dono `approval`, publicada com o nome
-- `v_inbox_pending_approvals_v2` porque a v1 continua publicada até o contract (M2-22). Uma linha
-- por `ApprovalApprover` `PENDING` de aprovação `PENDING`, com a política, a ordem, o prazo da linha
-- e os contadores das linhas vigentes (não `CANCELED`) para o andamento (RN-APV-67/70). Usa os
-- índices parciais `approval_approvers_pending_*` (US-133) e `approval_approvers_approval_idx`.
-- `security_invoker`: a RLS de `approvals` e `approval_approvers` vale para quem consulta.
-- Expand puro, reversível; nenhuma linha muda.
--
-- Desfazer (down): DROP VIEW "v_inbox_pending_approvals_v2".

SET ROLE cf_owner;

CREATE VIEW "v_inbox_pending_approvals_v2" WITH (security_invoker = true) AS
SELECT l.tenant_id,
       l.id AS approval_approver_id,
       l.approval_id,
       l.sequence,
       ap.decision_policy::text AS decision_policy,
       ap.process_id,
       ap.subject_type,
       ap.title,
       ap.requested_by_id,
       ap.requested_at,
       ap.due_at,
       l.due_at AS line_due_at,
       l.approver_type,
       l.approver_user_id,
       l.approver_role_id,
       l.approver_department_id,
       l.allow_deputy,
       c.total_lines,
       c.approved_lines,
       c.pending_lines,
       c.waiting_lines
  FROM approval_approvers l
  JOIN approvals ap ON ap.tenant_id = l.tenant_id AND ap.id = l.approval_id
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS total_lines,
           count(*) FILTER (WHERE o.status = 'APPROVED')::int AS approved_lines,
           count(*) FILTER (WHERE o.status = 'PENDING')::int AS pending_lines,
           count(*) FILTER (WHERE o.status = 'WAITING')::int AS waiting_lines
      FROM approval_approvers o
     WHERE o.tenant_id = l.tenant_id AND o.approval_id = l.approval_id AND o.status <> 'CANCELED'
  ) c
 WHERE l.status = 'PENDING' AND ap.status = 'PENDING';

GRANT SELECT ON "v_inbox_pending_approvals_v2" TO cf_app, cf_worker;

RESET ROLE;
