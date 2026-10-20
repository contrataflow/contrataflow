-- US-065 · Ciclo de vida do documento (entities.md §4.6/§4.7 `Document`, `DocumentVersion`,
-- `Approval`, `ApprovalDocument` · DEC-017/018/022/084 · RN-DOC-41..55). O `Document` guarda o
-- rascunho de trabalho e o status (DEC-018); cada finalização/submissão grava uma
-- `DocumentVersion` imutável (snapshot + SHA-256 do JSON canônico). A submissão avulsa de tipo com
-- `requires_approval` abre uma `Approval` (`subject_type = DOCUMENT`); a resolução completa do
-- aprovador e a aprovação de etapa são da US-051/US-052, que reaproveitam estas tabelas.

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "document_status" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'RETURNED', 'FINALIZED', 'APPROVED', 'REJECTED', 'CANCELED'
);
CREATE TYPE "version_reason" AS ENUM (
  'MANUAL', 'SUBMISSION', 'FINALIZATION', 'IMPORT', 'UPLOAD', 'REOPEN', 'SYSTEM'
);
CREATE TYPE "approval_subject_type" AS ENUM ('PROCESS_STAGE', 'DOCUMENT');
CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELED');
CREATE TYPE "approval_decision" AS ENUM ('APPROVE', 'RETURN', 'REJECT');

-- 2. Documentos.
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "template_version_id" UUID,
    "number" INTEGER,
    "year" INTEGER,
    "code" VARCHAR(60),
    "title" VARCHAR(250) NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'DRAFT',
    "confidentiality" "confidentiality" NOT NULL DEFAULT 'INTERNAL',
    "draft_content" JSONB NOT NULL DEFAULT '{"sections":{}}',
    "draft_revision" INTEGER NOT NULL DEFAULT 1,
    "singleton_key" UUID,
    "current_version_id" UUID,
    "approved_version_id" UUID,
    "pending_approval_id" UUID,
    "responsible_id" UUID,
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by_id" UUID,
    "finalized_at" TIMESTAMPTZ(6),
    "finalized_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "returned_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "reopened_at" TIMESTAMPTZ(6),
    "reopened_by_id" UUID,
    "reopen_reason" TEXT,
    "canceled_at" TIMESTAMPTZ(6),
    "canceled_by_id" UUID,
    "cancellation_reason" TEXT,
    "source_document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "documents_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- Processo, tipo e versão de template do mesmo tenant (DEC-081).
    CONSTRAINT "documents_tenant_id_process_id_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "documents_tenant_id_document_type_id_fkey"
      FOREIGN KEY ("tenant_id", "document_type_id") REFERENCES "document_types"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "documents_tenant_id_template_version_id_fkey"
      FOREIGN KEY ("tenant_id", "template_version_id")
      REFERENCES "document_template_versions"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "documents_title_length" CHECK (char_length("title") BETWEEN 1 AND 250),
    CONSTRAINT "documents_draft_revision_positive" CHECK ("draft_revision" >= 1),
    CONSTRAINT "documents_draft_content_shape"
      CHECK (jsonb_typeof("draft_content") = 'object'
             AND jsonb_typeof("draft_content" -> 'sections') = 'object'),
    -- RN-DOC-50: a chave de singularidade é o próprio tipo (nula para tipos múltiplos).
    CONSTRAINT "documents_singleton_key_is_type"
      CHECK ("singleton_key" IS NULL OR "singleton_key" = "document_type_id"),
    -- RN-DOC-48 · entities.md: cancelamento sempre justificado.
    CONSTRAINT "documents_cancellation_reason_required"
      CHECK ("status" <> 'CANCELED' OR "cancellation_reason" IS NOT NULL),
    CONSTRAINT "documents_reasons_length"
      CHECK (("reopen_reason" IS NULL OR char_length("reopen_reason") <= 2000)
             AND ("cancellation_reason" IS NULL OR char_length("cancellation_reason") <= 2000)),
    -- RN-DOC-49: só o rascunho nunca submetido é excluído (logicamente — DEC-034).
    CONSTRAINT "documents_deleted_only_draft"
      CHECK ("deleted_at" IS NULL OR "status" = 'DRAFT')
);
CREATE UNIQUE INDEX "documents_tenant_id_id_key" ON "documents"("tenant_id", "id");
-- Documento de origem (duplicação/importação) do mesmo tenant (depois do índice que ela referencia).
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_tenant_id_source_document_id_fkey"
  FOREIGN KEY ("tenant_id", "source_document_id") REFERENCES "documents"("tenant_id", "id")
  ON DELETE RESTRICT;
CREATE UNIQUE INDEX "documents_code_key" ON "documents"("tenant_id", "code") WHERE "code" IS NOT NULL;
-- RN-DOC-50 · V-08: um documento ativo por tipo singular no processo — a defesa definitiva sob
-- concorrência (a verificação prévia da aplicação só antecipa a mensagem).
CREATE UNIQUE INDEX "documents_singleton_key"
  ON "documents"("tenant_id", "process_id", "singleton_key")
  WHERE "singleton_key" IS NOT NULL AND "status" <> 'CANCELED' AND "deleted_at" IS NULL;
CREATE INDEX "documents_process_type_idx"
  ON "documents"("tenant_id", "process_id", "document_type_id");
CREATE INDEX "documents_status_idx" ON "documents"("tenant_id", "status");
CREATE INDEX "documents_responsible_idx" ON "documents"("tenant_id", "responsible_id", "status");

-- 3. Versões imutáveis.
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "reason" "version_reason" NOT NULL,
    "status_at_creation" "document_status" NOT NULL,
    "content" JSONB,
    "content_hash" VARCHAR(64) NOT NULL,
    "attachment_id" UUID,
    "template_version_id" UUID,
    "change_summary" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_versions_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "document_versions_tenant_id_document_id_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "document_versions_tenant_id_process_id_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "document_versions_tenant_id_template_version_id_fkey"
      FOREIGN KEY ("tenant_id", "template_version_id")
      REFERENCES "document_template_versions"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "document_versions_version_number_positive" CHECK ("version_number" >= 1),
    CONSTRAINT "document_versions_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "document_versions_content_object"
      CHECK ("content" IS NULL OR jsonb_typeof("content") = 'object')
);
CREATE UNIQUE INDEX "document_versions_tenant_id_id_key" ON "document_versions"("tenant_id", "id");
-- Alvo das FKs `documents.current_version_id`/`approved_version_id` (a versão é do próprio documento).
CREATE UNIQUE INDEX "document_versions_tenant_id_document_id_id_key"
  ON "document_versions"("tenant_id", "document_id", "id");
-- RN-DOC-53: numeração 1..n por documento — duas finalizações concorrentes nunca gravam a mesma.
CREATE UNIQUE INDEX "document_versions_number_key"
  ON "document_versions"("tenant_id", "document_id", "version_number");
CREATE INDEX "document_versions_process_idx" ON "document_versions"("tenant_id", "process_id");
CREATE INDEX "document_versions_hash_idx" ON "document_versions"("tenant_id", "content_hash");

-- Circulares e DEFERRABLE: a transição grava primeiro o documento (UPDATE condicionado à
-- `version` — o perdedor da corrida recebe 412 sem chegar a criar versão) e depois a versão nova.
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_current_version_fkey"
  FOREIGN KEY ("tenant_id", "id", "current_version_id")
  REFERENCES "document_versions"("tenant_id", "document_id", "id")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "documents_approved_version_fkey"
  FOREIGN KEY ("tenant_id", "id", "approved_version_id")
  REFERENCES "document_versions"("tenant_id", "document_id", "id")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- 4. Aprovações (entities.md §4.6 · DEC-022).
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "subject_type" "approval_subject_type" NOT NULL,
    "process_stage_id" UUID,
    "document_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_comment" TEXT,
    "approver_type" "approver_type" NOT NULL,
    "approver_user_id" UUID,
    "approver_role_id" UUID,
    "approver_department_id" UUID,
    "allow_deputy" BOOLEAN NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "status" "approval_status" NOT NULL DEFAULT 'PENDING',
    "decision" "approval_decision",
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_comment" TEXT,
    "decided_as_deputy" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "canceled_by_id" UUID,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approvals_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "approvals_tenant_id_process_id_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "approvals_tenant_id_process_stage_id_fkey"
      FOREIGN KEY ("tenant_id", "process_stage_id") REFERENCES "process_stages"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "approvals_tenant_id_document_id_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "approvals_title_length" CHECK (char_length("title") BETWEEN 1 AND 200),
    CONSTRAINT "approvals_stage_subject"
      CHECK ("subject_type" <> 'PROCESS_STAGE' OR "process_stage_id" IS NOT NULL),
    CONSTRAINT "approvals_document_subject"
      CHECK ("subject_type" <> 'DOCUMENT' OR "document_id" IS NOT NULL),
    CONSTRAINT "approvals_closed_dated"
      CHECK ("status" = 'PENDING' OR "decided_at" IS NOT NULL OR "canceled_at" IS NOT NULL),
    CONSTRAINT "approvals_decision_comment"
      CHECK ("decision" IS NULL OR "decision" NOT IN ('RETURN', 'REJECT')
             OR "decision_comment" IS NOT NULL),
    CONSTRAINT "approvals_user_approver"
      CHECK ("approver_type" <> 'USER' OR "approver_user_id" IS NOT NULL),
    CONSTRAINT "approvals_role_approver"
      CHECK ("approver_type" <> 'ROLE' OR "approver_role_id" IS NOT NULL),
    CONSTRAINT "approvals_department_approver"
      CHECK ("approver_type" <> 'DEPARTMENT_HEAD' OR "approver_department_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "approvals_tenant_id_id_key" ON "approvals"("tenant_id", "id");
-- RN-TRAM-43: no máximo uma pendência por etapa e por documento (avulsa), inclusive sob concorrência.
CREATE UNIQUE INDEX "approvals_pending_stage_key" ON "approvals"("tenant_id", "process_stage_id")
  WHERE "status" = 'PENDING' AND "subject_type" = 'PROCESS_STAGE';
CREATE UNIQUE INDEX "approvals_pending_document_key" ON "approvals"("tenant_id", "document_id")
  WHERE "status" = 'PENDING' AND "subject_type" = 'DOCUMENT';
CREATE INDEX "approvals_approver_user_idx" ON "approvals"("tenant_id", "approver_user_id")
  WHERE "status" = 'PENDING';
CREATE INDEX "approvals_approver_department_idx" ON "approvals"("tenant_id", "approver_department_id")
  WHERE "status" = 'PENDING';
CREATE INDEX "approvals_approver_role_idx" ON "approvals"("tenant_id", "approver_role_id")
  WHERE "status" = 'PENDING';
CREATE INDEX "approvals_process_idx" ON "approvals"("tenant_id", "process_id", "created_at" DESC);
CREATE INDEX "approvals_decided_by_idx" ON "approvals"("tenant_id", "decided_by_id", "decided_at" DESC);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_pending_approval_fkey"
  FOREIGN KEY ("tenant_id", "pending_approval_id") REFERENCES "approvals"("tenant_id", "id")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "approval_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_documents_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "approval_documents_tenant_id_approval_id_fkey"
      FOREIGN KEY ("tenant_id", "approval_id") REFERENCES "approvals"("tenant_id", "id")
      ON DELETE CASCADE,
    -- A versão analisada é do próprio documento coberto.
    CONSTRAINT "approval_documents_document_version_fkey"
      FOREIGN KEY ("tenant_id", "document_id", "document_version_id")
      REFERENCES "document_versions"("tenant_id", "document_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "approval_documents_tenant_id_id_key" ON "approval_documents"("tenant_id", "id");
CREATE UNIQUE INDEX "approval_documents_approval_document_key"
  ON "approval_documents"("tenant_id", "approval_id", "document_id");
CREATE INDEX "approval_documents_document_idx" ON "approval_documents"("tenant_id", "document_id");

-- 5. Imutabilidade.
-- 5.1 DEC-017 · RN-DOC-53: versão é snapshot imutável — só INSERT, inclusive por SQL direto.
CREATE FUNCTION cf_document_versions_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'document_versions é imutável (%)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Versões de documento são snapshots imutáveis: só INSERT (DEC-017 · RN-DOC-53).';
END
$fn$;
REVOKE ALL ON FUNCTION cf_document_versions_append_only() FROM PUBLIC;
CREATE TRIGGER "document_versions_append_only" BEFORE UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION cf_document_versions_append_only();

-- 5.2 O documento não muda de tenant, processo nem tipo; cancelado é final (DEC-018).
CREATE FUNCTION cf_documents_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."document_type_id" IS DISTINCT FROM OLD."document_type_id" THEN
    RAISE EXCEPTION 'documents: tenant, processo e tipo são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'CANCELED' AND NEW."status" IS DISTINCT FROM 'CANCELED' THEN
    RAISE EXCEPTION 'documents: documento cancelado não volta a outro status'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'CANCELED é final (DEC-018 · RN-DOC-48).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_documents_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "documents_immutable_columns" BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION cf_documents_immutable_columns();

-- 6. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('documents');
SELECT cf_apply_tenant_rls('document_versions');
SELECT cf_apply_tenant_rls('approvals');
SELECT cf_apply_tenant_rls('approval_documents');

-- 7. Privilégios mínimos: documento só tem exclusão lógica (DEC-034); versões e cobertura da
-- aprovação só INSERT; o worker lê (PDF — US-067; prazos e notificações — US-055/US-058).
GRANT SELECT, INSERT, UPDATE ON "documents" TO cf_app;
GRANT SELECT, INSERT ON "document_versions" TO cf_app;
GRANT SELECT, INSERT, UPDATE ON "approvals" TO cf_app;
GRANT SELECT, INSERT ON "approval_documents" TO cf_app;
GRANT SELECT ON "documents", "document_versions", "approvals", "approval_documents" TO cf_worker;

RESET ROLE;
