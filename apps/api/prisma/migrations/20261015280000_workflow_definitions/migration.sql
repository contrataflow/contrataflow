-- US-040 · Definição de workflow versionada (entities.md §4.5 · DEC-014/016/084 · RN-WF-01..22).
-- Workflow 1:N WorkflowVersion 1:N (WorkflowStage, WorkflowTransition, WorkflowRule). A versão
-- publicada é imutável: o snapshot canônico (RFC 8785) e o SHA-256 ficam na própria versão e os
-- gatilhos impedem qualquer escrita em etapas, transições e regras fora de `DRAFT` — inclusive por
-- SQL direto do papel da aplicação. Workflows não são excluídos (RN-WF-01). FKs compostas com a
-- versão garantem que transições e regras nunca apontem para etapas de outra versão ou tenant.

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "workflow_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE "stage_type" AS ENUM ('START', 'TASK', 'APPROVAL', 'END');
CREATE TYPE "department_resolution" AS ENUM
  ('FIXED', 'REQUESTING_DEPARTMENT', 'REQUESTING_SECRETARIAT', 'CHOSEN_ON_FORWARD');
CREATE TYPE "stage_assignment_policy" AS ENUM
  ('UNASSIGNED', 'CREATOR', 'DEPARTMENT_HEAD', 'PREVIOUS_ASSIGNEE');
CREATE TYPE "approver_type" AS ENUM ('USER', 'ROLE', 'DEPARTMENT_HEAD');
CREATE TYPE "transition_action" AS ENUM ('FORWARD', 'RETURN', 'APPROVE', 'REJECT', 'COMPLETE');
CREATE TYPE "day_count_type" AS ENUM ('BUSINESS', 'CALENDAR');
CREATE TYPE "rule_scope" AS ENUM ('STAGE_EXIT', 'TRANSITION');
CREATE TYPE "rule_type" AS ENUM
  ('REQUIRED_DOCUMENT', 'REQUIRED_FIELD', 'REQUIRED_APPROVAL', 'CONDITION');
CREATE TYPE "rule_severity" AS ENUM ('BLOCKING', 'WARNING');

-- 2. Tabelas.
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "applicability_rule" JSONB,
    "applicability_priority" INTEGER NOT NULL DEFAULT 100,
    "current_published_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflows_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- RN-WF-02.
    CONSTRAINT "workflows_key_format" CHECK ("key" ~ '^[A-Z][A-Z0-9_]{2,59}$'),
    CONSTRAINT "workflows_name_length" CHECK (char_length("name") BETWEEN 3 AND 150),
    CONSTRAINT "workflows_description_length"
      CHECK ("description" IS NULL OR char_length("description") <= 2000),
    CONSTRAINT "workflows_applicability_rule_object"
      CHECK ("applicability_rule" IS NULL OR jsonb_typeof("applicability_rule") = 'object')
);
CREATE UNIQUE INDEX "workflows_tenant_id_id_key" ON "workflows"("tenant_id", "id");
CREATE UNIQUE INDEX "workflows_tenant_id_key_key" ON "workflows"("tenant_id", "key");
-- Um único padrão por tenant (RN-WF-40 · US-042).
CREATE UNIQUE INDEX "workflows_tenant_id_default_key" ON "workflows"("tenant_id") WHERE "is_default";

CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "workflow_version_status" NOT NULL DEFAULT 'DRAFT',
    "initial_stage_id" UUID,
    "change_notes" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "published_by_id" UUID,
    "retired_at" TIMESTAMPTZ(6),
    "retired_by_id" UUID,
    "definition_snapshot" JSONB,
    "definition_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_versions_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "workflow_versions_tenant_id_workflow_id_fkey"
      FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflows"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "workflow_versions_version_number_positive" CHECK ("version_number" >= 1),
    -- RN-WF-20: publicada/aposentada sempre com snapshot, hash, data e etapa inicial.
    CONSTRAINT "workflow_versions_published_complete" CHECK (
      "status" = 'DRAFT'
      OR ("definition_snapshot" IS NOT NULL AND "definition_hash" IS NOT NULL
          AND "published_at" IS NOT NULL AND "initial_stage_id" IS NOT NULL)
    ),
    CONSTRAINT "workflow_versions_retired_complete"
      CHECK ("status" <> 'RETIRED' OR "retired_at" IS NOT NULL),
    CONSTRAINT "workflow_versions_hash_format"
      CHECK ("definition_hash" IS NULL OR "definition_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "workflow_versions_tenant_id_id_key" ON "workflow_versions"("tenant_id", "id");
-- Alvo da FK `workflows.current_published_version_id` (a versão é do próprio workflow).
CREATE UNIQUE INDEX "workflow_versions_tenant_id_workflow_id_id_key"
  ON "workflow_versions"("tenant_id", "workflow_id", "id");
-- RN-WF-04: número sequencial por workflow e no máximo um rascunho.
CREATE UNIQUE INDEX "workflow_versions_tenant_id_workflow_id_version_number_key"
  ON "workflow_versions"("tenant_id", "workflow_id", "version_number");
CREATE UNIQUE INDEX "workflow_versions_single_draft_key"
  ON "workflow_versions"("tenant_id", "workflow_id") WHERE "status" = 'DRAFT';

CREATE TABLE "workflow_stages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "instructions" TEXT,
    "type" "stage_type" NOT NULL,
    "group_label" VARCHAR(60),
    "display_order" INTEGER NOT NULL,
    "department_resolution" "department_resolution" NOT NULL,
    "fixed_department_id" UUID,
    "assignment_policy" "stage_assignment_policy" NOT NULL DEFAULT 'UNASSIGNED',
    "approver_type" "approver_type",
    "approver_user_id" UUID,
    "approver_role_id" UUID,
    "approver_department_resolution" "department_resolution",
    "approver_fixed_department_id" UUID,
    "allow_deputy" BOOLEAN NOT NULL DEFAULT true,
    "approval_document_type_codes" VARCHAR(40)[] NOT NULL DEFAULT '{}',
    "document_type_codes" VARCHAR(40)[] NOT NULL DEFAULT '{}',
    "sla_days" INTEGER,
    "sla_type" "day_count_type" NOT NULL DEFAULT 'BUSINESS',
    "color" VARCHAR(7),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_stages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_stages_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- Etapas só existem dentro da versão; descartar um rascunho leva as etapas junto.
    CONSTRAINT "workflow_stages_tenant_id_workflow_version_id_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id")
      REFERENCES "workflow_versions"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "workflow_stages_key_format" CHECK ("key" ~ '^[A-Z][A-Z0-9_]{1,59}$'),
    CONSTRAINT "workflow_stages_display_order_range" CHECK ("display_order" >= 0),
    -- entities.md §4.5 e RN-WF-08 (os demais condicionais ficam na aplicação).
    CONSTRAINT "workflow_stages_approver_required"
      CHECK ("type" <> 'APPROVAL' OR "approver_type" IS NOT NULL),
    CONSTRAINT "workflow_stages_approver_only_in_approval"
      CHECK ("type" = 'APPROVAL' OR "approver_type" IS NULL),
    CONSTRAINT "workflow_stages_approver_resolution"
      CHECK ("approver_department_resolution" IS DISTINCT FROM 'CHOSEN_ON_FORWARD'),
    CONSTRAINT "workflow_stages_fixed_department_required"
      CHECK ("department_resolution" <> 'FIXED' OR "fixed_department_id" IS NOT NULL),
    CONSTRAINT "workflow_stages_sla_days_range"
      CHECK ("sla_days" IS NULL OR "sla_days" BETWEEN 1 AND 365),
    CONSTRAINT "workflow_stages_end_without_sla" CHECK ("type" <> 'END' OR "sla_days" IS NULL),
    CONSTRAINT "workflow_stages_color_format" CHECK ("color" IS NULL OR "color" ~ '^#[0-9A-Fa-f]{6}$'),
    CONSTRAINT "workflow_stages_instructions_length"
      CHECK ("instructions" IS NULL OR char_length("instructions") <= 5000)
);
CREATE UNIQUE INDEX "workflow_stages_tenant_id_id_key" ON "workflow_stages"("tenant_id", "id");
-- Alvo das FKs compostas de transições, regras e da etapa inicial (mesma versão).
CREATE UNIQUE INDEX "workflow_stages_tenant_id_workflow_version_id_id_key"
  ON "workflow_stages"("tenant_id", "workflow_version_id", "id");
CREATE UNIQUE INDEX "workflow_stages_tenant_id_workflow_version_id_key_key"
  ON "workflow_stages"("tenant_id", "workflow_version_id", "key");
-- RN-WF-07: no máximo uma etapa inicial por versão.
CREATE UNIQUE INDEX "workflow_stages_single_start_key"
  ON "workflow_stages"("tenant_id", "workflow_version_id") WHERE "type" = 'START';

CREATE TABLE "workflow_transitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "from_stage_id" UUID NOT NULL,
    "to_stage_id" UUID NOT NULL,
    "action" "transition_action" NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "requires_comment" BOOLEAN NOT NULL DEFAULT false,
    "allow_due_date_override" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_transitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_transitions_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "workflow_transitions_tenant_id_workflow_version_id_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id")
      REFERENCES "workflow_versions"("tenant_id", "id") ON DELETE CASCADE,
    -- RN-WF-09: origem e destino da MESMA versão (excluir a etapa leva a transição junto).
    CONSTRAINT "workflow_transitions_from_stage_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id", "from_stage_id")
      REFERENCES "workflow_stages"("tenant_id", "workflow_version_id", "id") ON DELETE CASCADE,
    CONSTRAINT "workflow_transitions_to_stage_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id", "to_stage_id")
      REFERENCES "workflow_stages"("tenant_id", "workflow_version_id", "id") ON DELETE CASCADE,
    CONSTRAINT "workflow_transitions_key_format" CHECK ("key" ~ '^[A-Z][A-Z0-9_]{1,59}$'),
    CONSTRAINT "workflow_transitions_distinct_stages" CHECK ("from_stage_id" <> "to_stage_id"),
    -- RN-WF-09: devolução e indeferimento sempre exigem comentário.
    CONSTRAINT "workflow_transitions_comment_required"
      CHECK ("action" NOT IN ('RETURN', 'REJECT') OR "requires_comment"),
    CONSTRAINT "workflow_transitions_display_order_range" CHECK ("display_order" >= 0),
    CONSTRAINT "workflow_transitions_description_length"
      CHECK ("description" IS NULL OR char_length("description") <= 1000)
);
CREATE UNIQUE INDEX "workflow_transitions_tenant_id_id_key"
  ON "workflow_transitions"("tenant_id", "id");
CREATE UNIQUE INDEX "workflow_transitions_tenant_id_workflow_version_id_id_key"
  ON "workflow_transitions"("tenant_id", "workflow_version_id", "id");
CREATE UNIQUE INDEX "workflow_transitions_tenant_id_workflow_version_id_key_key"
  ON "workflow_transitions"("tenant_id", "workflow_version_id", "key");
CREATE UNIQUE INDEX "workflow_transitions_unique_edge_key"
  ON "workflow_transitions"("tenant_id", "workflow_version_id", "from_stage_id", "to_stage_id", "action");

CREATE TABLE "workflow_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "scope" "rule_scope" NOT NULL,
    "stage_id" UUID,
    "transition_id" UUID,
    "type" "rule_type" NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "severity" "rule_severity" NOT NULL DEFAULT 'BLOCKING',
    "config" JSONB NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_rules_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "workflow_rules_tenant_id_workflow_version_id_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id")
      REFERENCES "workflow_versions"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "workflow_rules_stage_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id", "stage_id")
      REFERENCES "workflow_stages"("tenant_id", "workflow_version_id", "id") ON DELETE CASCADE,
    CONSTRAINT "workflow_rules_transition_fkey"
      FOREIGN KEY ("tenant_id", "workflow_version_id", "transition_id")
      REFERENCES "workflow_transitions"("tenant_id", "workflow_version_id", "id") ON DELETE CASCADE,
    -- entities.md §4.5: alvo coerente com o escopo.
    CONSTRAINT "workflow_rules_scope_target" CHECK (
      ("scope" = 'STAGE_EXIT' AND "stage_id" IS NOT NULL AND "transition_id" IS NULL)
      OR ("scope" = 'TRANSITION' AND "transition_id" IS NOT NULL AND "stage_id" IS NULL)
    ),
    CONSTRAINT "workflow_rules_config_object" CHECK (jsonb_typeof("config") = 'object'),
    CONSTRAINT "workflow_rules_display_order_range" CHECK ("display_order" >= 0),
    CONSTRAINT "workflow_rules_description_length"
      CHECK ("description" IS NULL OR char_length("description") <= 2000)
);
CREATE UNIQUE INDEX "workflow_rules_tenant_id_id_key" ON "workflow_rules"("tenant_id", "id");
CREATE INDEX "workflow_rules_version_idx" ON "workflow_rules"("tenant_id", "workflow_version_id");

-- 3. FKs circulares (deferíveis: a versão e a etapa inicial nascem na mesma transação).
-- RN-WF-07: `initial_stage_id` é uma etapa da PRÓPRIA versão.
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_id_id_initial_stage_id_fkey"
  FOREIGN KEY ("tenant_id", "id", "initial_stage_id")
  REFERENCES "workflow_stages"("tenant_id", "workflow_version_id", "id")
  DEFERRABLE INITIALLY DEFERRED;
-- `current_published_version_id` é uma versão do PRÓPRIO workflow.
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_id_current_published_version_id_fkey"
  FOREIGN KEY ("tenant_id", "id", "current_published_version_id")
  REFERENCES "workflow_versions"("tenant_id", "workflow_id", "id")
  DEFERRABLE INITIALLY DEFERRED;

-- 4. Imutabilidade.
-- 4.1 `key` do workflow (RN-WF-02) e o tenant de qualquer linha nunca mudam.
CREATE FUNCTION cf_workflows_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."key" IS DISTINCT FROM OLD."key" THEN
    RAISE EXCEPTION 'workflows: key e tenant_id são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'A chave do workflow não muda depois da criação (US-040 · RN-WF-02).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_workflows_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "workflows_immutable_columns" BEFORE UPDATE ON "workflows"
  FOR EACH ROW EXECUTE FUNCTION cf_workflows_immutable_columns();

-- 4.2 `trg_wf_version_immutable` (RN-WF-21): fora de `DRAFT`, a versão só pode passar de
-- `PUBLISHED` para `RETIRED` (com `retired_at`/`retired_by_id`, `version` e `updated_*`); `DELETE`
-- de versão não `DRAFT` é recusado.
CREATE FUNCTION cf_wf_version_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable CONSTANT text[] := ARRAY['status', 'retired_at', 'retired_by_id', 'version',
                                   'updated_at', 'updated_by_id'];
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."workflow_id" IS DISTINCT FROM OLD."workflow_id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number" THEN
      RAISE EXCEPTION 'cf_wf_version_immutable: tenant, workflow e número da versão são imutáveis'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'cf_wf_version_immutable: rascunho não pode ser aposentado sem publicar'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cf_wf_version_immutable: versão % do workflow não é rascunho e não pode ser excluída', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Versão publicada é imutável (US-040 · RN-WF-21).';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED'
     AND (to_jsonb(NEW) - mutable) = (to_jsonb(OLD) - mutable) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cf_wf_version_immutable: versão % do workflow é imutável', OLD."id"
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Só PUBLISHED → RETIRED é permitido fora do rascunho (US-040 · RN-WF-21).';
END
$fn$;
REVOKE ALL ON FUNCTION cf_wf_version_immutable() FROM PUBLIC;
CREATE TRIGGER "trg_wf_version_immutable" BEFORE UPDATE OR DELETE ON "workflow_versions"
  FOR EACH ROW EXECUTE FUNCTION cf_wf_version_immutable();

-- 4.3 `trg_wf_definition_immutable` (RN-WF-05): etapas, transições e regras só mudam em versão
-- `DRAFT`. A linha da versão é lida com `FOR SHARE`, o que serializa a escrita com a publicação
-- (que trava a versão com `FOR UPDATE`). Versão inexistente só acontece na cascata do `DELETE` de
-- um rascunho (a linha-mãe já foi removida) — aí a exclusão segue.
CREATE FUNCTION cf_wf_definition_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target_versions uuid[];
  current_status workflow_version_status;
  target uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_versions := ARRAY[NEW."workflow_version_id"];
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."workflow_version_id" IS DISTINCT FROM OLD."workflow_version_id" THEN
      RAISE EXCEPTION 'cf_wf_definition_immutable: tenant e versão de %.% não mudam', TG_TABLE_NAME, OLD."id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    target_versions := ARRAY[OLD."workflow_version_id"];
  ELSE
    target_versions := ARRAY[OLD."workflow_version_id"];
  END IF;
  FOREACH target IN ARRAY target_versions LOOP
    SELECT v."status" INTO current_status
      FROM "workflow_versions" v WHERE v."id" = target FOR SHARE;
    IF NOT FOUND THEN
      IF TG_OP = 'DELETE' THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'cf_wf_definition_immutable: versão % inexistente', target
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF current_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'cf_wf_version_not_draft: % da versão % (%) não pode ser alterado', TG_TABLE_NAME, target, current_status
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'Versão publicada é imutável: crie uma nova versão (US-040 · RN-WF-05).';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_wf_definition_immutable() FROM PUBLIC;
CREATE TRIGGER "trg_wf_definition_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "workflow_stages"
  FOR EACH ROW EXECUTE FUNCTION cf_wf_definition_immutable();
CREATE TRIGGER "trg_wf_definition_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "workflow_transitions"
  FOR EACH ROW EXECUTE FUNCTION cf_wf_definition_immutable();
CREATE TRIGGER "trg_wf_definition_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "workflow_rules"
  FOR EACH ROW EXECUTE FUNCTION cf_wf_definition_immutable();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('workflows');
SELECT cf_apply_tenant_rls('workflow_versions');
SELECT cf_apply_tenant_rls('workflow_stages');
SELECT cf_apply_tenant_rls('workflow_transitions');
SELECT cf_apply_tenant_rls('workflow_rules');

-- 6. Privilégios mínimos: workflows nunca são excluídos (RN-WF-01); versões, etapas, transições e
-- regras só são excluídas em rascunho (gatilhos). O worker só lê (motor e caches — US-041).
GRANT SELECT, INSERT, UPDATE ON "workflows" TO cf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_versions" TO cf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_stages" TO cf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_transitions" TO cf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_rules" TO cf_app;
GRANT SELECT ON "workflows", "workflow_versions", "workflow_stages", "workflow_transitions",
  "workflow_rules" TO cf_worker;

RESET ROLE;
