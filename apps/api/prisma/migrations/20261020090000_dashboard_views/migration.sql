-- US-076 — Dashboard operacional por perfil (DSH-01/DSH-02 · DEC-088).
-- O módulo `dashboard` não tem tabela: agrega as views publicadas aqui pelos donos (`process` e
-- `timeline`), contrato público versionado como as `v_inbox_*` (DEC-026). Todas
-- `security_invoker`: a RLS das tabelas de origem vale para quem consulta (`cf_app`).
SET ROLE cf_owner;

-- 1. `process`: as colunas que os indicadores agregam (sem título, objeto nem descrição).
CREATE VIEW "v_dashboard_processes" WITH (security_invoker = true) AS
SELECT p.tenant_id,
       p.id,
       p.organization_id,
       p.deleted_at,
       p.code,
       p.status,
       p.is_budget_confidential,
       p.estimated_value,
       p.requesting_secretariat_id,
       p.requesting_department_id,
       p.current_department_id,
       p.current_responsible_id,
       p.current_workflow_stage_id,
       p.current_stage_due_at,
       p.overdue_since,
       p.opened_at
  FROM processes p
 WHERE p.deleted_at IS NULL;

-- 2. `process`: passagens concluídas por etapa (AVG_STAGE_DURATION — RN-DASH-05).
CREATE VIEW "v_dashboard_stage_passages" WITH (security_invoker = true) AS
SELECT s.tenant_id, s.process_id, s.workflow_stage_id, s.entered_at, s.exited_at
  FROM process_stages s
 WHERE s.exited_at IS NOT NULL;

-- 3. `timeline`: entradas da timeline (RECENT_ACTIVITY — RN-DASH-08).
CREATE VIEW "v_dashboard_timeline" WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id,
       t.process_id,
       t.occurred_at,
       t.type,
       t.actor_type,
       t.actor_id,
       t.actor_name,
       t.actor_department_name,
       t.entity_type,
       t.entity_id,
       t.movement_id,
       t.params,
       t.visibility
  FROM process_timeline_entries t;

-- 4. Índices de apoio (story "Banco de dados"; decisão em DEC-088).
--    AVG_STAGE_DURATION: a janela de 90 dias é um intervalo sobre `exited_at` de TODAS as etapas;
--    a chave começa por `exited_at` (a sugestão da story, `(tenant_id, workflow_stage_id,
--    exited_at)`, exigiria uma varredura por etapa) e carrega `workflow_stage_id` para o agrupamento.
CREATE INDEX "process_stages_exited_idx"
    ON "process_stages"("tenant_id", "exited_at", "workflow_stage_id")
    WHERE "exited_at" IS NOT NULL;

--    RECENT_ACTIVITY: as últimas entradas do tenant na ordem da timeline (`occurred_at DESC, id
--    DESC`), sem varrer processo a processo.
CREATE INDEX "process_timeline_entries_tenant_recent_idx"
    ON "process_timeline_entries"("tenant_id", "occurred_at" DESC, "id" DESC);

GRANT SELECT ON "v_dashboard_processes", "v_dashboard_stage_passages", "v_dashboard_timeline"
   TO cf_app, cf_worker;

RESET ROLE;
