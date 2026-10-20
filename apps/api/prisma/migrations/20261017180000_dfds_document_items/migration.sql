-- US-014 · DFD em wizard a partir de template (entities.md §4.7 `DocumentItem` e §4.8 `Dfd` ·
-- DEC-017/019/029/030). Primeiro documento tipado do produto:
--  * `document_items` (módulo document): linhas de item dos documentos tipados (DFD, ETP, TR) —
--    cada uma referencia um `ProcessItem` do mesmo processo (DEC-019), uma única vez por documento.
--    O DOC-07 substitui a coleção inteira (DELETE + INSERT na transação, com o documento travado e
--    a `version` do documento incrementada), por isso o papel da aplicação tem DELETE aqui.
--  * `dfds` (módulo dfd): cabeçalho tipado 1:1 do `Document` do tipo DFD. O id do DFD é o próprio id
--    do documento (CHECK `dfds_id_is_document`): as rotas da SCR-007 (`/processos/{id}/dfd/{dfdId}`)
--    e o painel de documentos (US-062) usam o mesmo identificador.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "dfd_wizard_step" AS ENUM (
  'IDENTIFICATION', 'JUSTIFICATION', 'PLANNING', 'REVIEW', 'CONCLUSION'
);

-- 2. Itens de documento.
CREATE TABLE "document_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "process_item_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "specification" JSONB,
    "acceptance_criteria" JSONB,
    "calculation_memo" JSONB,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,

    CONSTRAINT "document_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_items_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "document_items_document_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "document_items_process_item_fkey"
      FOREIGN KEY ("tenant_id", "process_item_id") REFERENCES "process_items"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "document_items_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "document_items_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "document_items_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "document_items_notes_length" CHECK (
      "notes" IS NULL OR char_length("notes") <= 1000
    ),
    CONSTRAINT "document_items_sort_order_range" CHECK ("sort_order" >= 0)
);

-- RN-DFD-14: o item do processo aparece uma única vez por documento.
CREATE UNIQUE INDEX "document_items_document_process_item_key"
  ON "document_items"("tenant_id", "document_id", "process_item_id");
-- Uso do item do processo (`ProcessItemUsageRegistry` — ITEM_IN_USE da US-006).
CREATE INDEX "document_items_process_item_idx" ON "document_items"("tenant_id", "process_item_id");

-- 3. Cabeçalho do DFD.
CREATE TABLE "dfds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "requesting_department_id" UUID NOT NULL,
    "responsible_id" UUID NOT NULL,
    "request_date" DATE NOT NULL,
    "object_summary" VARCHAR(2000) NOT NULL,
    "priority" "priority" NOT NULL,
    "expected_date" DATE,
    "estimated_value" DECIMAL(18,2),
    "pca_status" "pca_status" NOT NULL,
    "pca_year" INTEGER,
    "pca_item_code" VARCHAR(60),
    "pca_justification" TEXT,
    "wizard_step" "dfd_wizard_step" NOT NULL DEFAULT 'IDENTIFICATION',
    "completed_steps" "dfd_wizard_step"[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "dfds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dfds_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "dfds_document_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "dfds_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "dfds_requesting_department_fkey"
      FOREIGN KEY ("tenant_id", "requesting_department_id")
      REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "dfds_responsible_fkey"
      FOREIGN KEY ("responsible_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "dfds_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "dfds_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "dfds_id_is_document" CHECK ("id" = "document_id"),
    CONSTRAINT "dfds_object_summary_length" CHECK (
      char_length("object_summary") BETWEEN 10 AND 2000
    ),
    CONSTRAINT "dfds_expected_date_after_request" CHECK (
      "expected_date" IS NULL OR "expected_date" >= "request_date"
    ),
    CONSTRAINT "dfds_estimated_value_not_negative" CHECK (
      "estimated_value" IS NULL OR "estimated_value" >= 0
    ),
    -- Mesmas regras de PCA do processo (RN-DFD-13 · RN-PROC-12).
    CONSTRAINT "dfds_pca_justification"
      CHECK ("pca_status" <> 'NOT_PLANNED' OR "pca_justification" IS NOT NULL),
    CONSTRAINT "dfds_pca_year" CHECK ("pca_status" <> 'PLANNED' OR "pca_year" IS NOT NULL),
    CONSTRAINT "dfds_pca_year_range" CHECK ("pca_year" IS NULL OR "pca_year" BETWEEN 2000 AND 2100)
);

CREATE UNIQUE INDEX "dfds_tenant_id_id_key" ON "dfds"("tenant_id", "id");
-- 1:1 com o documento (entities.md §4.8).
CREATE UNIQUE INDEX "dfds_tenant_id_document_id_key" ON "dfds"("tenant_id", "document_id");
CREATE INDEX "dfds_process_idx" ON "dfds"("tenant_id", "process_id");

-- 4. Nenhuma linha muda de tenant, documento ou processo.
CREATE FUNCTION cf_document_items_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
     OR NEW."process_item_id" IS DISTINCT FROM OLD."process_item_id" THEN
    RAISE EXCEPTION 'document_items: tenant, documento e item são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_document_items_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "document_items_immutable_columns" BEFORE UPDATE ON "document_items"
  FOR EACH ROW EXECUTE FUNCTION cf_document_items_immutable_columns();

CREATE FUNCTION cf_dfds_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id" THEN
    RAISE EXCEPTION 'dfds: tenant, processo e documento são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_dfds_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "dfds_immutable_columns" BEFORE UPDATE ON "dfds"
  FOR EACH ROW EXECUTE FUNCTION cf_dfds_immutable_columns();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('document_items');
SELECT cf_apply_tenant_rls('dfds');

-- 6. Privilégios mínimos: o DFD nunca é apagado (o documento tem exclusão lógica); as linhas de
-- item são substituídas pelo DOC-07. O worker lê ambos (PDF do snapshot e IA).
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_items" TO cf_app;
GRANT SELECT, INSERT, UPDATE ON "dfds" TO cf_app;
GRANT SELECT ON "document_items" TO cf_worker;
GRANT SELECT ON "dfds" TO cf_worker;

RESET ROLE;
