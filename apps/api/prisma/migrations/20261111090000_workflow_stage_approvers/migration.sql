-- US-132 · M2-04 (parte da aprovação múltipla — entities.md MVP 2 §4.6/§10 · DEC-193 · DEC-014).
-- Expand, reversível: política de decisão na etapa (`decision_policy`, padrão `ANY` = MVP 1) e a
-- alçada por faixa (`decision_policy_rules`, `[]` — só a biblioteca de regras, US-198), mais a lista
-- ordenada `workflow_stage_approvers`. Nenhum backfill: toda etapa existente fica `ANY` sem linhas
-- (RN-APV-15). As demais colunas da M2-04 (`branch_key`, `applicability_rule` da etapa, condições
-- de transição, sementes…) entram com as stories donas. As linhas só mudam em versão `DRAFT`: o
-- gatilho `trg_wf_definition_immutable` passa a cobrir a tabela nova (por isso a linha repete
-- `workflow_version_id`, amarrada à etapa por FK composta).
--
-- Desfazer (down): DROP TABLE "workflow_stage_approvers"; ALTER TABLE "workflow_stages" DROP
-- CONSTRAINT "workflow_stages_decision_policy_only_in_approval", DROP CONSTRAINT
-- "workflow_stages_decision_policy_rules_array", DROP COLUMN "decision_policy_rules", DROP COLUMN
-- "decision_policy"; DROP TYPE "approval_decision_policy".

SET ROLE cf_owner;

-- 1. Enum (entities.md MVP 2 §2).
CREATE TYPE "approval_decision_policy" AS ENUM ('ANY', 'ALL', 'SEQUENTIAL');

-- 2. Etapa: política (RN-APV-01) e alçada (RN-APV-07). ADD COLUMN com padrão não dispara os
-- gatilhos de linha — versões publicadas continuam intactas.
ALTER TABLE "workflow_stages"
  ADD COLUMN "decision_policy" "approval_decision_policy" NOT NULL DEFAULT 'ANY',
  ADD COLUMN "decision_policy_rules" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "workflow_stages"
  ADD CONSTRAINT "workflow_stages_decision_policy_only_in_approval"
    CHECK ("type" = 'APPROVAL' OR "decision_policy" = 'ANY'),
  ADD CONSTRAINT "workflow_stages_decision_policy_rules_array"
    CHECK (jsonb_typeof("decision_policy_rules") = 'array');

-- 3. Lista ordenada de aprovadores (RN-APV-02..05).
CREATE TABLE "workflow_stage_approvers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "workflow_stage_id" UUID NOT NULL,
    "sequence" SMALLINT NOT NULL,
    "approver_type" "approver_type" NOT NULL,
    "approver_user_id" UUID,
    "approver_role_id" UUID,
    "approver_department_resolution" "department_resolution",
    "approver_fixed_department_id" UUID,
    "allow_deputy" BOOLEAN NOT NULL DEFAULT true,
    "applicability_rule" JSONB,
    "label" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_stage_approvers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_stage_approvers_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- A linha pertence à etapa da MESMA versão e tenant; excluir a etapa (só em rascunho, pelos
    -- gatilhos) leva as linhas junto.
    CONSTRAINT "workflow_stage_approvers_stage_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id", "workflow_stage_id")
      REFERENCES "workflow_stages"("tenant_id", "workflow_version_id", "id") ON DELETE CASCADE,
    CONSTRAINT "workflow_stage_approvers_sequence_range" CHECK ("sequence" BETWEEN 1 AND 20),
    -- RN-APV-04: tipo × coluna, como no aprovador único da etapa.
    CONSTRAINT "workflow_stage_approvers_user_by_type"
      CHECK (("approver_type" = 'USER') = ("approver_user_id" IS NOT NULL)),
    CONSTRAINT "workflow_stage_approvers_role_by_type"
      CHECK (("approver_type" = 'ROLE') = ("approver_role_id" IS NOT NULL)),
    CONSTRAINT "workflow_stage_approvers_head_by_type"
      CHECK (("approver_type" = 'DEPARTMENT_HEAD') = ("approver_department_resolution" IS NOT NULL)),
    CONSTRAINT "workflow_stage_approvers_resolution"
      CHECK ("approver_department_resolution" IS DISTINCT FROM 'CHOSEN_ON_FORWARD'),
    CONSTRAINT "workflow_stage_approvers_fixed_department"
      CHECK (("approver_department_resolution" IS NOT DISTINCT FROM 'FIXED')
             = ("approver_fixed_department_id" IS NOT NULL)),
    CONSTRAINT "workflow_stage_approvers_label_length"
      CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "workflow_stage_approvers_tenant_id_id_key"
  ON "workflow_stage_approvers"("tenant_id", "id");
-- RN-APV-03: `sequence` única na etapa (contígua de 1 a n, calculada pela aplicação).
CREATE UNIQUE INDEX "workflow_stage_approvers_sequence_key"
  ON "workflow_stage_approvers"("tenant_id", "workflow_stage_id", "sequence");
-- Leitura da definição inteira da versão (WF-09, validação, publicação e cópia).
CREATE INDEX "workflow_stage_approvers_version_idx"
  ON "workflow_stage_approvers"("tenant_id", "workflow_version_id");

-- 4. Imutabilidade (RN-APV-10 · DEC-014): o mesmo gatilho das etapas, transições e regras.
CREATE TRIGGER "trg_wf_definition_immutable" BEFORE INSERT OR UPDATE OR DELETE
  ON "workflow_stage_approvers"
  FOR EACH ROW EXECUTE FUNCTION cf_wf_definition_immutable();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('workflow_stage_approvers');

-- 6. Privilégios mínimos (como as demais tabelas da definição).
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_stage_approvers" TO cf_app;
GRANT SELECT ON "workflow_stage_approvers" TO cf_worker;

RESET ROLE;
