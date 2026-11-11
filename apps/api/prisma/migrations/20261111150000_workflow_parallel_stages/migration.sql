-- US-123 · M2-01/M2-04 (parte das etapas paralelas — entities.md MVP 2 §5.8 · DEC-194 · DEC-014).
-- Expand: `stage_type` ganha `PARALLEL_SPLIT`/`PARALLEL_JOIN` (ramificação e junção, sem
-- responsável, prazo nem aprovador) e `workflow_stages` ganha `branch_key` (ramo da etapa, calculado
-- e gravado na publicação — RN-WF2-07). Nenhum backfill: versões existentes não têm blocos. O
-- gatilho `trg_wf_definition_immutable` já cobre toda a linha (inclusive a coluna nova): fora de
-- `DRAFT` o `branch_key` não muda.
--
-- Desfazer (down): DROP INDEX "workflow_stages_branch_key_idx"; ALTER TABLE "workflow_stages" DROP
-- CONSTRAINT "workflow_stages_branch_key_scope", DROP CONSTRAINT
-- "workflow_stages_parallel_no_sla_approver", DROP COLUMN "branch_key". Os valores novos do enum
-- não saem (`ALTER TYPE … ADD VALUE` não é reversível no PostgreSQL); sem uso, são inofensivos.

SET ROLE cf_owner;

-- 1. Enum (entities.md MVP 2 §2). O valor novo só pode ser USADO depois do commit: os checks
-- abaixo comparam `type::text`, sem literal do enum.
ALTER TYPE "stage_type" ADD VALUE IF NOT EXISTS 'PARALLEL_SPLIT';
ALTER TYPE "stage_type" ADD VALUE IF NOT EXISTS 'PARALLEL_JOIN';

-- 2. Ramo da etapa (RN-WF2-07): a `key` da primeira etapa do ramo; nulo fora de ramos.
ALTER TABLE "workflow_stages" ADD COLUMN "branch_key" VARCHAR(60);

-- 3. RN-WF2-01: ramificação e junção sem prazo nem aprovador (check de entities.md §5.8); só
-- etapas de tarefa e de aprovação pertencem a um ramo.
ALTER TABLE "workflow_stages"
  ADD CONSTRAINT "workflow_stages_parallel_no_sla_approver"
    CHECK ("type"::text NOT IN ('PARALLEL_SPLIT', 'PARALLEL_JOIN')
           OR ("sla_days" IS NULL AND "approver_type" IS NULL)),
  ADD CONSTRAINT "workflow_stages_branch_key_scope"
    CHECK ("branch_key" IS NULL OR "type"::text IN ('TASK', 'APPROVAL'));

-- 4. Consulta por ramo (US-124/US-125): não único.
CREATE INDEX "workflow_stages_branch_key_idx"
  ON "workflow_stages"("tenant_id", "workflow_version_id", "branch_key")
  WHERE "branch_key" IS NOT NULL;

RESET ROLE;
