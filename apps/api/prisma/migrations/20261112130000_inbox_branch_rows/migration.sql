-- US-125 · RN-WF2-29/30/37/38 (ramos paralelos na caixa de tarefas — DEC-194 · DEC-026 · DEC-108).
--
-- `v_inbox_processes` passa a produzir UMA LINHA POR ETAPA ATIVA de trabalho: no paralelismo, o
-- split (`PARALLEL_SPLIT`, a raiz do bloco, nunca acionável) sai da junção e cada ramo ativo vira
-- uma linha, com a responsabilidade ativa DA ETAPA (`process_assignments_stage_active_key`). Fora
-- do paralelismo a linha é a mesma do MVP 1 (o tronco tem uma etapa ativa e a responsabilidade
-- continua casada pelo processo). Colunas novas AO FINAL (`CREATE OR REPLACE VIEW` aditivo):
--   process_stage_id        a etapa da linha (= `stage_id`; nome do contrato da story);
--   branch_key              ramo da etapa (nulo no tronco);
--   split_process_stage_id  split que abriu o ramo;
--   stage_workflow_stage_id etapa da versão da linha (no ramo, a da etapa — não a do split);
--   stage_department_id     unidade da etapa da linha;
--   active_stages_count     etapas ativas do processo (US-124).
--
-- `v_inbox_pending_approvals_v2` ganha `process_stage_id` e `branch_key` (a etapa da aprovação),
-- para a linha de aprovação se casar com a linha do processo da MESMA etapa.
--
-- Usa os índices parciais existentes (`process_stages_active_idx`,
-- `process_assignments_stage_active_key`/`process_assignments_active_idx`). Expand puro: nenhuma
-- linha de tabela muda; sem backfill (nenhum processo estava em ramificação antes do deploy).
--
-- Desfazer (down): recriar as duas views com a definição anterior (migrações
-- 20261019150000_task_inbox_views e 20261112110000_inbox_pending_approval_lines) depois de
-- `DROP VIEW` — as colunas novas não podem sair por `CREATE OR REPLACE`.

SET ROLE cf_owner;

CREATE OR REPLACE VIEW "v_inbox_processes" WITH (security_invoker = true) AS
SELECT p.tenant_id,
       p.id,
       p.organization_id,
       p.deleted_at,
       p.code,
       p.number,
       p.year,
       p.title,
       p.status,
       p.version,
       p.is_budget_confidential,
       p.requesting_secretariat_id,
       p.requesting_department_id,
       p.current_department_id,
       p.current_responsible_id,
       p.current_workflow_stage_id,
       s.id AS stage_id,
       s.entered_at,
       s.due_at,
       s.overdue_since,
       s.sla_type,
       s.paused_at,
       a.department_id AS assignment_department_id,
       a.assignee_id,
       a.type AS assignment_type,
       s.id AS process_stage_id,
       s.branch_key,
       s.split_process_stage_id,
       s.workflow_stage_id AS stage_workflow_stage_id,
       s.department_id AS stage_department_id,
       p.active_stages_count
  FROM processes p
  LEFT JOIN process_stages s
         ON s.tenant_id = p.tenant_id AND s.process_id = p.id AND s.status = 'ACTIVE'
        AND s.stage_type NOT IN ('PARALLEL_SPLIT', 'PARALLEL_JOIN')
  LEFT JOIN process_assignments a
         ON a.tenant_id = p.tenant_id AND a.process_id = p.id AND a.is_active
        AND (s.branch_key IS NULL OR a.process_stage_id = s.id)
 WHERE p.deleted_at IS NULL;

CREATE OR REPLACE VIEW "v_inbox_pending_approvals_v2" WITH (security_invoker = true) AS
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
       c.waiting_lines,
       ap.process_stage_id,
       st.branch_key
  FROM approval_approvers l
  JOIN approvals ap ON ap.tenant_id = l.tenant_id AND ap.id = l.approval_id
  LEFT JOIN process_stages st
         ON st.tenant_id = ap.tenant_id AND st.id = ap.process_stage_id
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS total_lines,
           count(*) FILTER (WHERE o.status = 'APPROVED')::int AS approved_lines,
           count(*) FILTER (WHERE o.status = 'PENDING')::int AS pending_lines,
           count(*) FILTER (WHERE o.status = 'WAITING')::int AS waiting_lines
      FROM approval_approvers o
     WHERE o.tenant_id = l.tenant_id AND o.approval_id = l.approval_id AND o.status <> 'CANCELED'
  ) c
 WHERE l.status = 'PENDING' AND ap.status = 'PENDING';

RESET ROLE;
