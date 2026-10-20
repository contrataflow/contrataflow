-- US-036 · Criar TR e editar suas seções (entities.md §4.8 `TermOfReference` · DEC-016/017/018/
-- 028/030/032 · ADR-006):
--  * `terms_of_reference` (módulo term): cabeçalho tipado 1:1 do `Document` do tipo TR. O id do TR é
--    o próprio id do documento (CHECK `terms_of_reference_id_is_document`), como no DFD, no ETP e na
--    pesquisa de preços: a SCR-012 (`/processos/{id}/tr/{termId}`), as seções (DOC-05), os itens
--    (DOC-06/07) e as versões usam o mesmo identificador. Sem status próprio (o do documento).
--  * Valor estimado com origem rastreável (RN-TR-07/08): `PRICE_RESEARCH` exige a pesquisa
--    vinculada; `ETP` vem da importação (US-037); `MANUAL` é informado.
--  * Condições contratuais tipadas (US-038) já com os limites de entities.md §4.8.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "award_type" AS ENUM ('BY_ITEM', 'BY_LOT', 'GLOBAL');

-- 2. Cabeçalho do TR.
CREATE TABLE "terms_of_reference" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "object_definition" VARCHAR(2000) NOT NULL,
    "contract_duration_months" INTEGER,
    "execution_deadline" INTEGER,
    "execution_deadline_type" "day_count_type",
    "delivery_location" TEXT,
    "payment_term_days" INTEGER,
    "product_warranty_months" INTEGER,
    "contract_guarantee_percent" DECIMAL(9,4),
    "allows_subcontracting" BOOLEAN,
    "selection_criterion_id" UUID,
    "award_type" "award_type",
    "estimated_total_value" DECIMAL(18,2),
    "estimated_value_source" "estimated_value_source",
    "price_research_id" UUID,
    "imported_from_etp_id" UUID,
    "imported_from_etp_version_id" UUID,
    "imported_at" TIMESTAMPTZ(6),
    "imported_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "terms_of_reference_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "terms_of_reference_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_document_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_selection_criterion_fkey"
      FOREIGN KEY ("tenant_id", "selection_criterion_id")
      REFERENCES "catalog_items"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_price_research_fkey"
      FOREIGN KEY ("tenant_id", "price_research_id") REFERENCES "price_research"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_imported_from_etp_fkey"
      FOREIGN KEY ("tenant_id", "imported_from_etp_id") REFERENCES "etps"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_imported_from_etp_version_fkey"
      FOREIGN KEY ("tenant_id", "imported_from_etp_version_id")
      REFERENCES "document_versions"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_imported_by_fkey"
      FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "terms_of_reference_id_is_document" CHECK ("id" = "document_id"),
    CONSTRAINT "terms_of_reference_object_definition_length" CHECK (
      char_length("object_definition") BETWEEN 1 AND 2000
    ),
    CONSTRAINT "terms_of_reference_estimated_value_source" CHECK (
      "estimated_value_source" IS NULL
      OR "estimated_value_source" IN ('PRICE_RESEARCH', 'ETP', 'MANUAL')
    ),
    -- RN-TR-08: a origem PRICE_RESEARCH sempre aponta a pesquisa vinculada.
    CONSTRAINT "terms_of_reference_price_research_source" CHECK (
      "estimated_value_source" IS DISTINCT FROM 'PRICE_RESEARCH' OR "price_research_id" IS NOT NULL
    ),
    CONSTRAINT "terms_of_reference_estimated_total_not_negative" CHECK (
      "estimated_total_value" IS NULL OR "estimated_total_value" >= 0
    ),
    CONSTRAINT "terms_of_reference_execution_deadline_type" CHECK (
      "execution_deadline" IS NULL OR "execution_deadline_type" IS NOT NULL
    ),
    CONSTRAINT "terms_of_reference_execution_deadline_positive" CHECK (
      "execution_deadline" IS NULL OR "execution_deadline" >= 1
    ),
    CONSTRAINT "terms_of_reference_contract_duration" CHECK (
      "contract_duration_months" IS NULL OR "contract_duration_months" BETWEEN 1 AND 120
    ),
    CONSTRAINT "terms_of_reference_payment_term" CHECK (
      "payment_term_days" IS NULL OR "payment_term_days" BETWEEN 1 AND 90
    ),
    CONSTRAINT "terms_of_reference_product_warranty" CHECK (
      "product_warranty_months" IS NULL OR "product_warranty_months" BETWEEN 0 AND 120
    ),
    -- Lei 14.133/2021, arts. 96 a 98.
    CONSTRAINT "terms_of_reference_contract_guarantee" CHECK (
      "contract_guarantee_percent" IS NULL OR "contract_guarantee_percent" BETWEEN 0 AND 10
    )
);

CREATE UNIQUE INDEX "terms_of_reference_tenant_id_id_key" ON "terms_of_reference"("tenant_id", "id");
-- 1:1 com o documento (entities.md §4.8).
CREATE UNIQUE INDEX "terms_of_reference_tenant_id_document_id_key"
  ON "terms_of_reference"("tenant_id", "document_id");
CREATE INDEX "terms_of_reference_process_idx" ON "terms_of_reference"("tenant_id", "process_id");

-- 3. O TR nunca muda de tenant, processo ou documento.
CREATE FUNCTION cf_terms_of_reference_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id" THEN
    RAISE EXCEPTION 'terms_of_reference: tenant, processo e documento são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_terms_of_reference_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "terms_of_reference_immutable_columns" BEFORE UPDATE ON "terms_of_reference"
  FOR EACH ROW EXECUTE FUNCTION cf_terms_of_reference_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('terms_of_reference');

-- 5. Privilégios mínimos: o TR nunca é apagado (o documento tem exclusão lógica). O worker lê
-- (PDF e snapshot).
GRANT SELECT, INSERT, UPDATE ON "terms_of_reference" TO cf_app;
GRANT SELECT ON "terms_of_reference" TO cf_worker;

RESET ROLE;
