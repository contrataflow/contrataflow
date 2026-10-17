-- US-067 · PDFs dos documentos (entities.md §4 `DocumentRendition` · DEC-060 · ADR-007 ·
-- queues.md §4.4 · storage.md §10). A linha é a "outbox do trabalho" do `document-render`
-- (padrão B — queues.md §3): criada `PENDING` na transação do pedido (DOC-20/21) e enfileirada
-- depois do commit com `jobId = id`. O binário fica no bucket `renditions`; aqui só o estado, o
-- hash e a chave (sempre no prefixo do tenant). Sem DELETE: prévias vencidas viram `EXPIRED`.

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "rendition_kind" AS ENUM ('PREVIEW', 'CONTENT', 'APPROVAL_STAMPED', 'SIGNED');
CREATE TYPE "rendition_status" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED');

-- 2. Tabela.
CREATE TABLE "document_renditions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID,
    "draft_revision" INTEGER,
    "approval_id" UUID,
    "kind" "rendition_kind" NOT NULL,
    "status" "rendition_status" NOT NULL DEFAULT 'PENDING',
    -- POL-09: gerado com os valores sigilosos ocultos (decidido no pedido, pelo solicitante).
    "masked" BOOLEAN NOT NULL DEFAULT false,
    "storage_key" VARCHAR(512),
    "sha256" VARCHAR(64),
    "size_bytes" BIGINT,
    "page_count" INTEGER,
    "error_code" VARCHAR(60),
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_by_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_renditions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_renditions_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "document_renditions_process_id_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "document_renditions_document_id_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "document_renditions_version_fkey"
      FOREIGN KEY ("tenant_id", "document_id", "document_version_id")
      REFERENCES "document_versions"("tenant_id", "document_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "document_renditions_approval_id_fkey"
      FOREIGN KEY ("tenant_id", "approval_id") REFERENCES "approvals"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "document_renditions_requested_by_id_fkey"
      FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- RN-DOC-63: prévia = rascunho (revisão, validade de 24 h, sem versão); as demais = versão.
    CONSTRAINT "document_renditions_preview_shape"
      CHECK ("kind" <> 'PREVIEW'
             OR ("document_version_id" IS NULL AND "draft_revision" IS NOT NULL
                 AND "expires_at" IS NOT NULL)),
    CONSTRAINT "document_renditions_version_required"
      CHECK ("kind" = 'PREVIEW' OR "document_version_id" IS NOT NULL),
    CONSTRAINT "document_renditions_approval_shape"
      CHECK (("kind" = 'APPROVAL_STAMPED') = ("approval_id" IS NOT NULL)),
    -- RN-DOC-65: `READY` só com o PDF gravado (chave, hash, tamanho e páginas).
    CONSTRAINT "document_renditions_ready_complete"
      CHECK ("status" <> 'READY'
             OR ("storage_key" IS NOT NULL AND "sha256" IS NOT NULL AND "size_bytes" IS NOT NULL
                 AND "page_count" IS NOT NULL AND "ready_at" IS NOT NULL)),
    CONSTRAINT "document_renditions_failed_code"
      CHECK ("status" <> 'FAILED' OR "error_code" IS NOT NULL),
    CONSTRAINT "document_renditions_sha256_format"
      CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "document_renditions_attempts_positive" CHECK ("attempts" >= 0),
    -- storage.md §4/§13: chave sempre no prefixo do próprio tenant (guarda também no banco).
    CONSTRAINT "document_renditions_storage_key_tenant"
      CHECK ("storage_key" IS NULL
             OR starts_with("storage_key", 'tenants/' || "tenant_id"::text || '/'))
);

CREATE UNIQUE INDEX "document_renditions_tenant_id_id_key"
  ON "document_renditions"("tenant_id", "id");
-- FA-01: um PDF por versão (e por par versão × aprovação), por forma de POL-09 (completo ou com
-- os valores sigilosos ocultos). A falha não ocupa o lugar: "Tentar novamente" cria outra linha.
CREATE UNIQUE INDEX "document_renditions_content_key"
  ON "document_renditions"("tenant_id", "document_version_id", "masked")
  WHERE "kind" = 'CONTENT' AND "status" <> 'FAILED';
CREATE UNIQUE INDEX "document_renditions_stamped_key"
  ON "document_renditions"("tenant_id", "document_version_id", "approval_id", "masked")
  WHERE "kind" = 'APPROVAL_STAMPED' AND "status" <> 'FAILED';
CREATE INDEX "document_renditions_document_idx"
  ON "document_renditions"("tenant_id", "document_id", "kind", "created_at" DESC);
-- Reconciliador (queues.md §4.8) e alerta de "rendition presa" (observability.md).
CREATE INDEX "document_renditions_pending_idx"
  ON "document_renditions"("status", "requested_at")
  WHERE "status" IN ('PENDING', 'PROCESSING');
-- `previews-expire` do `maintenance` (RN-DOC-68).
CREATE INDEX "document_renditions_preview_expiry_idx"
  ON "document_renditions"("tenant_id", "expires_at")
  WHERE "kind" = 'PREVIEW' AND "status" <> 'EXPIRED';

-- 3. Máquina de estados (RN-DOC-65/67/68) e colunas imutáveis.
CREATE FUNCTION cf_document_renditions_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
     OR NEW."document_version_id" IS DISTINCT FROM OLD."document_version_id"
     OR NEW."draft_revision" IS DISTINCT FROM OLD."draft_revision"
     OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."masked" IS DISTINCT FROM OLD."masked"
     OR NEW."requested_by_id" IS DISTINCT FROM OLD."requested_by_id"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" THEN
    RAISE EXCEPTION 'document_renditions: origem, tipo e solicitante são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'READY'
     AND (NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
          OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
          OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes") THEN
    RAISE EXCEPTION 'document_renditions: PDF pronto é de escrita única'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('PROCESSING', 'FAILED', 'EXPIRED'))
    OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('READY', 'FAILED', 'EXPIRED'))
    OR (OLD."status" = 'READY' AND NEW."status" = 'EXPIRED' AND OLD."kind" = 'PREVIEW')
  ) THEN
    RAISE EXCEPTION 'document_renditions: transição de status inválida (% → %)',
      OLD."status", NEW."status"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'EXPIRED' AND NEW."kind" <> 'PREVIEW' THEN
    RAISE EXCEPTION 'document_renditions: só a prévia expira'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_document_renditions_guard() FROM PUBLIC;
CREATE TRIGGER "document_renditions_guard" BEFORE UPDATE ON "document_renditions"
  FOR EACH ROW EXECUTE FUNCTION cf_document_renditions_guard();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('document_renditions');

-- 5. Privilégios mínimos: sem DELETE. O worker executa o `document-render` (com o código da API),
-- a tarefa `previews-expire` do `maintenance` e resolve o destinatário de `DOCUMENT_RENDER_FAILED`.
GRANT SELECT, INSERT, UPDATE ON "document_renditions" TO cf_app;
GRANT SELECT, UPDATE ON "document_renditions" TO cf_worker;

RESET ROLE;
