-- US-001 · Processo de contratação e runtime da tramitação (entities.md §4.4 · DEC-010/013/014/
-- 024/028/029 · RN-PROC-01..18). Cria `processes` (agregado central), `process_stages` (passagens),
-- `process_assignments` (responsabilidade), `process_movements` (tramitações, imutável) e
-- `process_access` (concessões de visibilidade — DEC-024), com FKs compostas por tenant (DEC-081),
-- a FK circular `processes.current_stage_id` → `process_stages` DEFERRABLE INITIALLY DEFERRED
-- (a etapa nasce na mesma transação), checks de PCA/numeração, índices parciais e trigram, a
-- coluna gerada `search_vector` (FTS `portuguese` sem acento) e a FK pendente desde a US-059
-- (`process_timeline_entries.process_id`). Extensões `pg_trgm`/`unaccent` vêm do init (RN-FND-14).

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "pca_status" AS ENUM ('PLANNED', 'NOT_PLANNED', 'NOT_APPLICABLE');
CREATE TYPE "estimated_value_source" AS ENUM ('MANUAL', 'DFD', 'ETP', 'PRICE_RESEARCH', 'TERM');
CREATE TYPE "creation_channel" AS ENUM ('WEB', 'DUPLICATION', 'IMPORT', 'API');
CREATE TYPE "process_status" AS ENUM (
  'DRAFT', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RETURNED', 'SUSPENDED', 'CANCELED', 'COMPLETED',
  'PUBLISHED'
);
CREATE TYPE "process_stage_status" AS ENUM ('ACTIVE', 'COMPLETED', 'RETURNED', 'CANCELED');
CREATE TYPE "assignment_type" AS ENUM ('STAGE_ENTRY', 'CLAIM', 'MANUAL', 'RETURN');
CREATE TYPE "movement_action" AS ENUM (
  'CREATE', 'FORWARD', 'RETURN', 'CLAIM', 'ASSIGN', 'APPROVE', 'REJECT', 'COMPLETE', 'CANCEL',
  'SUSPEND', 'RESUME'
);
CREATE TYPE "principal_type" AS ENUM ('DEPARTMENT', 'USER');
CREATE TYPE "process_access_reason" AS ENUM (
  'REQUESTING', 'CURRENT', 'HISTORICAL', 'CREATOR', 'RESPONSIBLE', 'PARTICIPANT', 'APPROVER'
);

-- 2. `unaccent` não é IMMUTABLE (depende do dicionário da sessão): a coluna gerada precisa de um
-- invólucro imutável com o dicionário fixo (DEC-057).
CREATE FUNCTION cf_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $fn$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $fn$;

-- 3. Processo.
CREATE TABLE "processes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" INTEGER,
    "year" INTEGER NOT NULL,
    "code" VARCHAR(40),
    "internal_code" VARCHAR(60),
    "title" VARCHAR(200) NOT NULL,
    "object" TEXT NOT NULL,
    "description" TEXT,
    "contracting_type_id" UUID NOT NULL,
    "modality_id" UUID,
    "is_price_registration" BOOLEAN NOT NULL DEFAULT false,
    "requesting_secretariat_id" UUID NOT NULL,
    "requesting_department_id" UUID NOT NULL,
    "current_department_id" UUID NOT NULL,
    "current_responsible_id" UUID,
    "priority" "priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "process_status" NOT NULL DEFAULT 'DRAFT',
    "status_before_suspension" "process_status",
    "workflow_version_id" UUID NOT NULL,
    "current_stage_id" UUID,
    "current_workflow_stage_id" UUID,
    "current_stage_due_at" TIMESTAMPTZ(6),
    "overdue_since" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6),
    "target_date" DATE,
    "estimated_value" DECIMAL(18,2),
    "estimated_value_source" "estimated_value_source",
    "is_budget_confidential" BOOLEAN NOT NULL DEFAULT false,
    "origin_id" UUID NOT NULL,
    "creation_channel" "creation_channel" NOT NULL DEFAULT 'WEB',
    "pca_status" "pca_status" NOT NULL,
    "pca_year" INTEGER,
    "pca_item_code" VARCHAR(60),
    "pca_justification" TEXT,
    "notes" TEXT,
    "duplicated_from_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_id" UUID,
    "canceled_at" TIMESTAMPTZ(6),
    "canceled_by_id" UUID,
    "cancellation_reason" TEXT,
    "suspended_at" TIMESTAMPTZ(6),
    "suspended_by_id" UUID,
    "suspension_reason" TEXT,
    "search_vector" tsvector GENERATED ALWAYS AS (
      to_tsvector(
        'portuguese'::regconfig,
        cf_unaccent(
          coalesce("code", '') || ' ' || coalesce("internal_code", '') || ' ' || "title" || ' ' ||
          "object" || ' ' || coalesce("description", '')
        )
      )
    ) STORED,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,

    CONSTRAINT "processes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "processes_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "processes_current_responsible_fkey"
      FOREIGN KEY ("current_responsible_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "processes_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- RN-PROC-01/09 · V-01/V-02 (o domínio confere antes; aqui a última barreira).
    CONSTRAINT "processes_title_length" CHECK (char_length("title") BETWEEN 5 AND 200),
    CONSTRAINT "processes_object_length" CHECK (char_length("object") BETWEEN 10 AND 2000),
    CONSTRAINT "processes_year_range" CHECK ("year" BETWEEN 2000 AND 2100),
    -- RN-PROC-04 (DEC-028): número e código nascem juntos (ou nenhum, na autuação — FA-03).
    CONSTRAINT "processes_number_code" CHECK (("number" IS NULL) = ("code" IS NULL)),
    CONSTRAINT "processes_number_positive" CHECK ("number" IS NULL OR "number" > 0),
    -- RN-PROC-12 (DEC-029).
    CONSTRAINT "processes_pca_justification"
      CHECK ("pca_status" <> 'NOT_PLANNED' OR "pca_justification" IS NOT NULL),
    CONSTRAINT "processes_pca_year" CHECK ("pca_status" <> 'PLANNED' OR "pca_year" IS NOT NULL),
    CONSTRAINT "processes_suspension_status"
      CHECK ("status" <> 'SUSPENDED' OR "status_before_suspension" IS NOT NULL),
    CONSTRAINT "processes_cancellation_reason"
      CHECK ("status" <> 'CANCELED' OR "cancellation_reason" IS NOT NULL),
    -- RN-PROC-10.
    CONSTRAINT "processes_estimated_value"
      CHECK ("estimated_value" IS NULL OR "estimated_value" >= 0),
    CONSTRAINT "processes_estimated_value_source"
      CHECK ("estimated_value" IS NULL OR "estimated_value_source" IS NOT NULL)
);

-- Alvo das FKs compostas (DEC-081).
CREATE UNIQUE INDEX "processes_tenant_id_id_key" ON "processes"("tenant_id", "id");
-- RN-PROC-04/09 (V-10): código único no tenant; código interno único entre os não descartados.
CREATE UNIQUE INDEX "processes_code_key" ON "processes"("tenant_id", "code") WHERE "code" IS NOT NULL;
CREATE UNIQUE INDEX "processes_internal_code_key" ON "processes"("tenant_id", "internal_code")
  WHERE "internal_code" IS NOT NULL AND "deleted_at" IS NULL;
-- Listas, caixa, prazos e numeração (entities.md §4.4).
CREATE INDEX "processes_status_idx" ON "processes"("tenant_id", "status", "updated_at" DESC);
CREATE INDEX "processes_current_department_idx"
  ON "processes"("tenant_id", "current_department_id", "status");
CREATE INDEX "processes_current_responsible_idx"
  ON "processes"("tenant_id", "current_responsible_id", "status");
CREATE INDEX "processes_requesting_secretariat_idx"
  ON "processes"("tenant_id", "requesting_secretariat_id", "status");
CREATE INDEX "processes_organization_year_number_idx"
  ON "processes"("tenant_id", "organization_id", "year", "number");
CREATE INDEX "processes_current_stage_due_idx" ON "processes"("tenant_id", "current_stage_due_at")
  WHERE "status" IN ('IN_PROGRESS', 'AWAITING_APPROVAL', 'RETURNED');
CREATE INDEX "processes_overdue_idx" ON "processes"("tenant_id", "overdue_since")
  WHERE "overdue_since" IS NOT NULL;
CREATE INDEX "processes_target_date_idx" ON "processes"("tenant_id", "target_date");
-- Heurística de duplicidade (RN-PROC-13): janela recente por tenant.
CREATE INDEX "processes_created_at_idx" ON "processes"("tenant_id", "created_at" DESC);
-- Busca (US-002 · DEC-057): FTS e trigram em código e título.
CREATE INDEX "processes_search_idx" ON "processes" USING GIN ("search_vector");
CREATE INDEX "processes_code_trgm_idx" ON "processes" USING GIN ("code" gin_trgm_ops);
CREATE INDEX "processes_title_trgm_idx" ON "processes" USING GIN ("title" gin_trgm_ops);

-- 4. Passagens por etapa (uma ACTIVE por processo — DEC-014).
CREATE TABLE "process_stages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "workflow_stage_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "process_stage_status" NOT NULL DEFAULT 'ACTIVE',
    "department_id" UUID NOT NULL,
    "assignee_id" UUID,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exited_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "sla_days" INTEGER,
    "sla_type" "day_count_type",
    "due_date_overridden" BOOLEAN NOT NULL DEFAULT false,
    "due_date_override_reason" TEXT,
    "paused_at" TIMESTAMPTZ(6),
    "paused_total_seconds" INTEGER NOT NULL DEFAULT 0,
    "overdue_since" TIMESTAMPTZ(6),
    "due_soon_notified_at" TIMESTAMPTZ(6),
    "overdue_notified_at" TIMESTAMPTZ(6),
    "entered_via_movement_id" UUID,
    "exited_via_movement_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "process_stages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_stages_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_stages_assignee_fkey"
      FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_stages_sequence_positive" CHECK ("sequence" > 0),
    CONSTRAINT "process_stages_exited" CHECK ("status" = 'ACTIVE' OR "exited_at" IS NOT NULL),
    CONSTRAINT "process_stages_override_reason"
      CHECK (NOT "due_date_overridden" OR "due_date_override_reason" IS NOT NULL),
    CONSTRAINT "process_stages_paused_total" CHECK ("paused_total_seconds" >= 0)
);

CREATE UNIQUE INDEX "process_stages_tenant_id_id_key" ON "process_stages"("tenant_id", "id");
CREATE UNIQUE INDEX "process_stages_sequence_key"
  ON "process_stages"("tenant_id", "process_id", "sequence");
CREATE UNIQUE INDEX "process_stages_single_active_key" ON "process_stages"("tenant_id", "process_id")
  WHERE "status" = 'ACTIVE';
CREATE INDEX "process_stages_department_idx" ON "process_stages"("tenant_id", "department_id")
  WHERE "status" = 'ACTIVE';
CREATE INDEX "process_stages_assignee_idx" ON "process_stages"("tenant_id", "assignee_id")
  WHERE "status" = 'ACTIVE';
CREATE INDEX "process_stages_due_idx" ON "process_stages"("tenant_id", "due_at")
  WHERE "status" = 'ACTIVE';

-- 5. Responsabilidade (um registro ativo por processo).
CREATE TABLE "process_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "process_stage_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "assignee_id" UUID,
    "type" "assignment_type" NOT NULL,
    "assigned_by_id" UUID,
    "reason" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_assignments_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_assignments_assignee_fkey"
      FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_assignments_assigned_by_fkey"
      FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_assignments_ended" CHECK ("is_active" OR "ended_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "process_assignments_tenant_id_id_key"
  ON "process_assignments"("tenant_id", "id");
CREATE UNIQUE INDEX "process_assignments_single_active_key"
  ON "process_assignments"("tenant_id", "process_id") WHERE "is_active";
CREATE INDEX "process_assignments_assignee_idx" ON "process_assignments"("tenant_id", "assignee_id")
  WHERE "is_active";
CREATE INDEX "process_assignments_queue_idx" ON "process_assignments"("tenant_id", "department_id")
  WHERE "is_active" AND "assignee_id" IS NULL;

-- 6. Tramitações (imutável — só `INSERT`).
CREATE TABLE "process_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" "movement_action" NOT NULL,
    "workflow_transition_id" UUID,
    "from_process_stage_id" UUID,
    "to_process_stage_id" UUID,
    "from_workflow_stage_id" UUID,
    "to_workflow_stage_id" UUID,
    "from_department_id" UUID,
    "to_department_id" UUID,
    "from_user_id" UUID,
    "to_user_id" UUID,
    "status_from" "process_status",
    "status_to" "process_status",
    "actor_type" "actor_type" NOT NULL DEFAULT 'USER',
    "actor_id" UUID,
    "actor_department_id" UUID,
    "comment" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "documents" JSONB NOT NULL DEFAULT '[]',
    "approval_id" UUID,
    "ip" INET,
    "user_agent" VARCHAR(512),
    "correlation_id" VARCHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_movements_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_movements_from_user_fkey"
      FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_movements_to_user_fkey"
      FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_movements_actor_fkey"
      FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_movements_sequence_positive" CHECK ("sequence" > 0),
    CONSTRAINT "process_movements_comment_required"
      CHECK ("action" NOT IN ('RETURN', 'REJECT', 'CANCEL', 'SUSPEND') OR "comment" IS NOT NULL),
    CONSTRAINT "process_movements_comment_length"
      CHECK ("comment" IS NULL OR char_length("comment") <= 5000),
    CONSTRAINT "process_movements_documents_array" CHECK (jsonb_typeof("documents") = 'array'),
    CONSTRAINT "process_movements_metadata_object" CHECK (jsonb_typeof("metadata") = 'object')
);

CREATE UNIQUE INDEX "process_movements_tenant_id_id_key" ON "process_movements"("tenant_id", "id");
CREATE UNIQUE INDEX "process_movements_sequence_key"
  ON "process_movements"("tenant_id", "process_id", "sequence");
CREATE INDEX "process_movements_process_idx"
  ON "process_movements"("tenant_id", "process_id", "occurred_at" DESC);
CREATE INDEX "process_movements_to_department_idx"
  ON "process_movements"("tenant_id", "to_department_id", "occurred_at" DESC);
CREATE INDEX "process_movements_actor_idx"
  ON "process_movements"("tenant_id", "actor_id", "occurred_at" DESC);

-- 7. Concessões de visibilidade (DEC-024 · permissions.md §5).
CREATE TABLE "process_access" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "principal_type" "principal_type" NOT NULL,
    "department_id" UUID,
    "user_id" UUID,
    "reason" "process_access_reason" NOT NULL,
    "source_id" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "process_access_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_access_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_access_user_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_access_department_principal"
      CHECK (("principal_type" = 'DEPARTMENT') = ("department_id" IS NOT NULL)),
    CONSTRAINT "process_access_user_principal"
      CHECK (("principal_type" = 'USER') = ("user_id" IS NOT NULL))
);

CREATE UNIQUE INDEX "process_access_tenant_id_id_key" ON "process_access"("tenant_id", "id");
-- Concessão ativa única por (principal, motivo).
CREATE UNIQUE INDEX "process_access_active_key" ON "process_access"(
  "tenant_id", "process_id", "principal_type", COALESCE("department_id", "user_id"), "reason"
) WHERE "revoked_at" IS NULL;
-- Predicado de visibilidade (permissions.md §5).
CREATE INDEX "process_access_department_idx"
  ON "process_access"("tenant_id", "department_id", "process_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "process_access_user_idx"
  ON "process_access"("tenant_id", "user_id", "process_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "process_access_process_idx" ON "process_access"("tenant_id", "process_id");

-- 8. FKs compostas (DEC-081). A validação de FK para tabela com RLS FORCE roda como o dono, sujeito
-- à RLS: tenant nulo só para a validação, dentro de BEGIN/COMMIT explícitos (prisma/README.md).
BEGIN;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE "processes"
  ADD CONSTRAINT "processes_organization_fkey"
  FOREIGN KEY ("tenant_id", "organization_id")
  REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT;
-- RN-PROC-02: secretaria e setor do MESMO órgão do processo.
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_requesting_secretariat_fkey"
  FOREIGN KEY ("tenant_id", "organization_id", "requesting_secretariat_id")
  REFERENCES "departments"("tenant_id", "organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_requesting_department_fkey"
  FOREIGN KEY ("tenant_id", "organization_id", "requesting_department_id")
  REFERENCES "departments"("tenant_id", "organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_current_department_fkey"
  FOREIGN KEY ("tenant_id", "current_department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_contracting_type_fkey"
  FOREIGN KEY ("tenant_id", "contracting_type_id")
  REFERENCES "catalog_items"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_modality_fkey"
  FOREIGN KEY ("tenant_id", "modality_id")
  REFERENCES "catalog_items"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_origin_fkey"
  FOREIGN KEY ("tenant_id", "origin_id")
  REFERENCES "catalog_items"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_workflow_version_fkey"
  FOREIGN KEY ("tenant_id", "workflow_version_id")
  REFERENCES "workflow_versions"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_current_workflow_stage_fkey"
  FOREIGN KEY ("tenant_id", "current_workflow_stage_id")
  REFERENCES "workflow_stages"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_duplicated_from_fkey"
  FOREIGN KEY ("tenant_id", "duplicated_from_id")
  REFERENCES "processes"("tenant_id", "id") ON DELETE RESTRICT;
-- Circular (processo ↔ etapa): verificada no COMMIT da criação.
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_current_stage_fkey"
  FOREIGN KEY ("tenant_id", "current_stage_id")
  REFERENCES "process_stages"("tenant_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "process_stages"
  ADD CONSTRAINT "process_stages_process_fkey"
  FOREIGN KEY ("tenant_id", "process_id")
  REFERENCES "processes"("tenant_id", "id") ON DELETE CASCADE;
ALTER TABLE "process_stages"
  ADD CONSTRAINT "process_stages_workflow_stage_fkey"
  FOREIGN KEY ("tenant_id", "workflow_stage_id")
  REFERENCES "workflow_stages"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "process_stages"
  ADD CONSTRAINT "process_stages_department_fkey"
  FOREIGN KEY ("tenant_id", "department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "process_stages"
  ADD CONSTRAINT "process_stages_entered_via_fkey"
  FOREIGN KEY ("tenant_id", "entered_via_movement_id")
  REFERENCES "process_movements"("tenant_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "process_stages"
  ADD CONSTRAINT "process_stages_exited_via_fkey"
  FOREIGN KEY ("tenant_id", "exited_via_movement_id")
  REFERENCES "process_movements"("tenant_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "process_assignments"
  ADD CONSTRAINT "process_assignments_process_fkey"
  FOREIGN KEY ("tenant_id", "process_id")
  REFERENCES "processes"("tenant_id", "id") ON DELETE CASCADE;
ALTER TABLE "process_assignments"
  ADD CONSTRAINT "process_assignments_stage_fkey"
  FOREIGN KEY ("tenant_id", "process_stage_id")
  REFERENCES "process_stages"("tenant_id", "id") ON DELETE CASCADE;
ALTER TABLE "process_assignments"
  ADD CONSTRAINT "process_assignments_department_fkey"
  FOREIGN KEY ("tenant_id", "department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE "process_movements"
  ADD CONSTRAINT "process_movements_process_fkey"
  FOREIGN KEY ("tenant_id", "process_id")
  REFERENCES "processes"("tenant_id", "id") ON DELETE CASCADE;
ALTER TABLE "process_movements"
  ADD CONSTRAINT "process_movements_from_stage_fkey"
  FOREIGN KEY ("tenant_id", "from_process_stage_id")
  REFERENCES "process_stages"("tenant_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "process_movements"
  ADD CONSTRAINT "process_movements_to_stage_fkey"
  FOREIGN KEY ("tenant_id", "to_process_stage_id")
  REFERENCES "process_stages"("tenant_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "process_movements"
  ADD CONSTRAINT "process_movements_from_department_fkey"
  FOREIGN KEY ("tenant_id", "from_department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "process_movements"
  ADD CONSTRAINT "process_movements_to_department_fkey"
  FOREIGN KEY ("tenant_id", "to_department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "process_movements"
  ADD CONSTRAINT "process_movements_actor_department_fkey"
  FOREIGN KEY ("tenant_id", "actor_department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "process_movements"
  ADD CONSTRAINT "process_movements_transition_fkey"
  FOREIGN KEY ("tenant_id", "workflow_transition_id")
  REFERENCES "workflow_transitions"("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE "process_access"
  ADD CONSTRAINT "process_access_process_fkey"
  FOREIGN KEY ("tenant_id", "process_id")
  REFERENCES "processes"("tenant_id", "id") ON DELETE CASCADE;
ALTER TABLE "process_access"
  ADD CONSTRAINT "process_access_department_fkey"
  FOREIGN KEY ("tenant_id", "department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;

-- US-059: a timeline aponta para o processo (pendente até este agregado existir).
ALTER TABLE "process_timeline_entries"
  ADD CONSTRAINT "process_timeline_entries_process_fkey"
  FOREIGN KEY ("tenant_id", "process_id")
  REFERENCES "processes"("tenant_id", "id") ON DELETE CASCADE;
COMMIT;

-- 9. Imutabilidade: o processo nunca muda de tenant nem de versão de workflow (RN-PROC-06 ·
-- RN-WF-33); a tramitação é um registro histórico (só INSERT).
CREATE FUNCTION cf_processes_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."workflow_version_id" IS DISTINCT FROM OLD."workflow_version_id"
     OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id" THEN
    RAISE EXCEPTION 'processes: tenant_id, workflow_version_id e created_by_id são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'A versão do workflow é fixada na criação (RN-PROC-06).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_processes_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "processes_immutable_columns" BEFORE UPDATE ON "processes"
  FOR EACH ROW EXECUTE FUNCTION cf_processes_immutable_columns();

CREATE FUNCTION cf_process_movements_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'process_movements é imutável (%)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Tramitações são registro histórico: só INSERT (entities.md §4.4).';
END
$fn$;
REVOKE ALL ON FUNCTION cf_process_movements_append_only() FROM PUBLIC;

CREATE TRIGGER "process_movements_append_only" BEFORE UPDATE OR DELETE ON "process_movements"
  FOR EACH ROW EXECUTE FUNCTION cf_process_movements_append_only();

-- 10. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('processes');
SELECT cf_apply_tenant_rls('process_stages');
SELECT cf_apply_tenant_rls('process_assignments');
SELECT cf_apply_tenant_rls('process_movements');
SELECT cf_apply_tenant_rls('process_access');

-- 11. Privilégios mínimos: exclusão lógica do processo (descarte do rascunho — US-009); tramitação
-- só INSERT; o worker lê (prazos, notificações) e mantém prazos/concessões (US-055/US-012).
GRANT SELECT, INSERT, UPDATE ON "processes" TO cf_app;
GRANT SELECT, UPDATE ON "processes" TO cf_worker;
GRANT SELECT, INSERT, UPDATE ON "process_stages" TO cf_app;
GRANT SELECT, UPDATE ON "process_stages" TO cf_worker;
GRANT SELECT, INSERT, UPDATE ON "process_assignments" TO cf_app;
GRANT SELECT ON "process_assignments" TO cf_worker;
GRANT SELECT, INSERT ON "process_movements" TO cf_app;
GRANT SELECT ON "process_movements" TO cf_worker;
GRANT SELECT, INSERT, UPDATE ON "process_access" TO cf_app;
GRANT SELECT, UPDATE ON "process_access" TO cf_worker;

RESET ROLE;
