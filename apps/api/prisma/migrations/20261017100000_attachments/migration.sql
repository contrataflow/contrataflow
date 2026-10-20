-- US-068 · Upload seguro de anexos (entities.md §4 `Attachment` · storage.md §4/§5 · DEC-136).
-- O binário nunca entra no banco: a linha guarda o estado do fluxo intenção → upload direto →
-- confirmação → varredura (padrão B — queues.md §3: a própria linha é a "outbox do trabalho" do
-- `file-scan`). As chaves de storage são montadas no servidor (`StorageKeyBuilder`) e o banco
-- confere o prefixo do tenant (RN-DOC-77). Exclusão só lógica (DEC-034): sem DELETE.

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "attachment_target_type" AS ENUM (
  'PROCESS', 'DOCUMENT', 'DOCUMENT_VERSION', 'PRICE_SOURCE', 'COMMENT', 'MOVEMENT', 'RISK',
  'TENANT_ASSET', 'TEMPLATE_VERSION'
);
CREATE TYPE "attachment_status" AS ENUM (
  'PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'AVAILABLE', 'INFECTED', 'REJECTED', 'DELETED'
);

-- 2. Tabela.
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID,
    "target_type" "attachment_target_type" NOT NULL,
    "target_id" UUID,
    "category_id" UUID,
    "file_name" VARCHAR(255) NOT NULL,
    "extension" VARCHAR(10) NOT NULL,
    "declared_mime_type" VARCHAR(120) NOT NULL,
    "detected_mime_type" VARCHAR(120),
    "size_bytes" BIGINT NOT NULL,
    "sha256" VARCHAR(64),
    "storage_key" VARCHAR(512) NOT NULL,
    "quarantine_key" VARCHAR(512),
    "status" "attachment_status" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "scan_result" JSONB,
    "scanned_at" TIMESTAMPTZ(6),
    "description" VARCHAR(500),
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6),
    "deletion_reason" TEXT,
    "source_attachment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attachments_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "attachments_process_id_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "attachments_category_id_fkey"
      FOREIGN KEY ("tenant_id", "category_id") REFERENCES "catalog_items"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "attachments_uploaded_by_id_fkey"
      FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- entities.md §4: só ativos do tenant e versões de template ficam fora de processo.
    CONSTRAINT "attachments_process_required"
      CHECK ("target_type" IN ('TENANT_ASSET', 'TEMPLATE_VERSION') OR "process_id" IS NOT NULL),
    CONSTRAINT "attachments_size_positive" CHECK ("size_bytes" > 0),
    CONSTRAINT "attachments_extension_format" CHECK ("extension" ~ '^[a-z0-9]{1,10}$'),
    CONSTRAINT "attachments_file_name_not_empty" CHECK (char_length("file_name") >= 1),
    CONSTRAINT "attachments_sha256_format" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    -- RN-DOC-77: chaves sempre no prefixo do próprio tenant (guarda também no banco).
    CONSTRAINT "attachments_storage_key_tenant"
      CHECK (starts_with("storage_key", 'tenants/' || "tenant_id"::text || '/')),
    CONSTRAINT "attachments_quarantine_key_tenant"
      CHECK ("quarantine_key" IS NULL
             OR starts_with("quarantine_key", 'tenants/' || "tenant_id"::text || '/uploads/')),
    -- Invariante P3 (storage.md §5.1): `AVAILABLE` só depois de varredura limpa e completa.
    CONSTRAINT "attachments_available_scanned"
      CHECK ("status" <> 'AVAILABLE'
             OR ("sha256" IS NOT NULL AND "scanned_at" IS NOT NULL
                 AND "detected_mime_type" IS NOT NULL)),
    -- DEC-034: excluído ⇔ `deleted_at`, sempre com motivo (RN-DOC-79).
    CONSTRAINT "attachments_deleted_consistent"
      CHECK (("status" = 'DELETED') = ("deleted_at" IS NOT NULL)),
    CONSTRAINT "attachments_deletion_reason_required"
      CHECK ("status" <> 'DELETED' OR "deletion_reason" IS NOT NULL),
    CONSTRAINT "attachments_scan_result_object"
      CHECK ("scan_result" IS NULL OR jsonb_typeof("scan_result") = 'object')
);

-- Alvo das FKs compostas (DEC-081) e cópia lógica (DEC-033).
CREATE UNIQUE INDEX "attachments_tenant_id_id_key" ON "attachments"("tenant_id", "id");
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_source_attachment_id_fkey"
  FOREIGN KEY ("tenant_id", "source_attachment_id") REFERENCES "attachments"("tenant_id", "id")
  ON DELETE RESTRICT;
CREATE INDEX "attachments_process_created_idx"
  ON "attachments"("tenant_id", "process_id", "created_at" DESC);
CREATE INDEX "attachments_target_idx" ON "attachments"("tenant_id", "target_type", "target_id");
CREATE INDEX "attachments_sha256_idx" ON "attachments"("tenant_id", "sha256");
-- `maintenance` (abandono — RN-DOC-78) e alerta de "anexo preso" (queues.md §15.3).
CREATE INDEX "attachments_pending_status_idx" ON "attachments"("tenant_id", "status")
  WHERE "status" IN ('PENDING_UPLOAD', 'UPLOADED', 'SCANNING');

-- 3. Máquina de estados (storage.md §5.1) e colunas imutáveis: nenhum caminho de código promove a
-- `AVAILABLE` sem passar por `SCANNING` (P3), e estados terminais não voltam.
CREATE FUNCTION cf_attachments_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."target_type" IS DISTINCT FROM OLD."target_type"
     OR NEW."target_id" IS DISTINCT FROM OLD."target_id"
     OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
     OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
     OR NEW."uploaded_by_id" IS DISTINCT FROM OLD."uploaded_by_id" THEN
    RAISE EXCEPTION 'attachments: alvo, chave, tamanho e autor são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING_UPLOAD' AND NEW."status" IN ('UPLOADED', 'REJECTED', 'DELETED'))
    OR (OLD."status" = 'UPLOADED' AND NEW."status" = 'SCANNING')
    OR (OLD."status" = 'SCANNING' AND NEW."status" IN ('AVAILABLE', 'INFECTED', 'REJECTED'))
    OR (OLD."status" = 'AVAILABLE' AND NEW."status" = 'DELETED')
  ) THEN
    RAISE EXCEPTION 'attachments: transição de status inválida (% → %)', OLD."status", NEW."status"
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'storage.md §5.1 — AVAILABLE só pelo file-scan (P3).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_attachments_guard() FROM PUBLIC;
CREATE TRIGGER "attachments_guard" BEFORE UPDATE ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION cf_attachments_guard();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('attachments');

-- 5. Privilégios mínimos: sem DELETE (DEC-034). O worker executa o `file-scan` e a tarefa de
-- abandono do `maintenance` (RN-DOC-78) e resolve o destinatário de `ATTACHMENT_REJECTED`.
GRANT SELECT, INSERT, UPDATE ON "attachments" TO cf_app;
GRANT SELECT, UPDATE ON "attachments" TO cf_worker;

RESET ROLE;
