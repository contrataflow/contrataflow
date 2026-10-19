-- US-056 — Caixa de tarefas unificada (DEC-026 · domains.md `inbox` · entities.md §4).
-- O módulo `inbox` não tem tabela: lê as views publicadas pelos donos (`process` e `approval`),
-- contrato público versionado aqui. Todas `security_invoker`: a RLS das tabelas de origem vale
-- para quem consulta (`cf_app`), nunca para o dono da view.
SET ROLE cf_owner;

-- 1. `process`: o processo com a passagem ativa e a responsabilidade ativa (ambas opcionais — o
--    processo seguido pode estar sem custódia). As junções usam os índices parciais
--    `process_stages_single_active_key` e `process_assignments_single_active_key`.
CREATE VIEW "v_inbox_processes" WITH (security_invoker = true) AS
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
       a.type AS assignment_type
  FROM processes p
  LEFT JOIN process_stages s
         ON s.tenant_id = p.tenant_id AND s.process_id = p.id AND s.status = 'ACTIVE'
  LEFT JOIN process_assignments a
         ON a.tenant_id = p.tenant_id AND a.process_id = p.id AND a.is_active
 WHERE p.deleted_at IS NULL;

-- 2. `process`: participações individuais não revogadas (visão "Acompanhando" — RN-INBOX-08).
CREATE VIEW "v_inbox_participations" WITH (security_invoker = true) AS
SELECT pp.tenant_id, pp.process_id, pp.user_id, pp.role, pp.expires_at
  FROM process_participants pp
 WHERE pp.revoked_at IS NULL AND pp.user_id IS NOT NULL;

-- 3. `approval`: aprovações pendentes com o aprovador registrado (POL-03 · DEC-022).
CREATE VIEW "v_inbox_pending_approvals" WITH (security_invoker = true) AS
SELECT ap.tenant_id,
       ap.id,
       ap.process_id,
       ap.subject_type,
       ap.title,
       ap.requested_by_id,
       ap.requested_at,
       ap.due_at,
       ap.approver_type,
       ap.approver_user_id,
       ap.approver_role_id,
       ap.approver_department_id,
       ap.allow_deputy
  FROM approvals ap
 WHERE ap.status = 'PENDING';

-- 4. Índice da visão "Acompanhando" (story US-056 · "Impacto técnico").
CREATE INDEX "process_participants_following_idx"
    ON "process_participants"("tenant_id", "user_id")
    WHERE "revoked_at" IS NULL AND "user_id" IS NOT NULL;

GRANT SELECT ON "v_inbox_processes", "v_inbox_participations", "v_inbox_pending_approvals"
   TO cf_app, cf_worker;

RESET ROLE;
