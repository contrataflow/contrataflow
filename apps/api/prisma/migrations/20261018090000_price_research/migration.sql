-- US-024 · Criar pesquisa de preços a partir dos itens do processo (entities.md §4.8
-- `PriceResearch`/`PriceItem` · DEC-018/019/020/030):
--  * `price_research` (módulo price-research): cabeçalho tipado 1:1 do `Document` do tipo
--    PRICE_RESEARCH com o snapshot dos parâmetros `priceResearch.*` fixado na criação (RN-PRICE-05).
--    O id da pesquisa é o próprio id do documento (CHECK `price_research_id_is_document`), como no
--    DFD: a SCR-009 (`/processos/{id}/pesquisa-precos/{researchId}`) e o painel de documentos usam
--    o mesmo identificador. Sem status próprio (status do documento + `completed_at`).
--  * `price_items`: uma linha por item canônico do processo na pesquisa (único por item), apagada
--    em cascata com a pesquisa. As cotações (`quotations`, US-026) referenciarão `price_items` com
--    `ON DELETE CASCADE` (RN-PRICE-11) — por isso o papel da aplicação tem DELETE aqui.

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "price_default_method" AS ENUM ('AUTO_CV', 'MEAN', 'MEDIAN', 'LOWEST');
CREATE TYPE "price_calculation_method" AS ENUM ('MEAN', 'MEDIAN', 'LOWEST', 'MANUAL');

-- 2. Cabeçalho da pesquisa.
CREATE TABLE "price_research" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "reference_date" DATE NOT NULL,
    "default_method" "price_default_method" NOT NULL,
    "cv_threshold_percent" DECIMAL(9,4) NOT NULL,
    "min_quotations" INTEGER NOT NULL,
    "direct_quote_max_age_days" INTEGER NOT NULL,
    "similar_contract_max_age_days" INTEGER NOT NULL,
    "outlier_lower_percent" DECIMAL(9,4) NOT NULL,
    "outlier_upper_percent" DECIMAL(9,4) NOT NULL,
    "unit_price_decimals" SMALLINT NOT NULL,
    "rounding_mode" VARCHAR(10) NOT NULL,
    "total_estimated_value" DECIMAL(18,2),
    "items_count" INTEGER NOT NULL DEFAULT 0,
    "items_with_alerts_count" INTEGER NOT NULL DEFAULT 0,
    "last_calculated_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "price_research_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_research_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_research_document_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "price_research_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "price_research_completed_by_fkey"
      FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_research_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_research_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_research_id_is_document" CHECK ("id" = "document_id"),
    CONSTRAINT "price_research_min_quotations" CHECK ("min_quotations" >= 1),
    CONSTRAINT "price_research_unit_price_decimals" CHECK ("unit_price_decimals" IN (2, 4)),
    CONSTRAINT "price_research_rounding_mode" CHECK ("rounding_mode" IN ('HALF_UP', 'HALF_EVEN')),
    CONSTRAINT "price_research_max_age_days" CHECK (
      "direct_quote_max_age_days" >= 1 AND "similar_contract_max_age_days" >= 1
    ),
    CONSTRAINT "price_research_percentages" CHECK (
      "cv_threshold_percent" > 0
      AND "outlier_lower_percent" > 0 AND "outlier_lower_percent" <= 100
      AND "outlier_upper_percent" >= 100
    ),
    CONSTRAINT "price_research_counts" CHECK (
      "items_count" >= 0 AND "items_with_alerts_count" BETWEEN 0 AND "items_count"
    ),
    CONSTRAINT "price_research_total_not_negative" CHECK (
      "total_estimated_value" IS NULL OR "total_estimated_value" >= 0
    )
);

CREATE UNIQUE INDEX "price_research_tenant_id_id_key" ON "price_research"("tenant_id", "id");
-- 1:1 com o documento (entities.md §4.8).
CREATE UNIQUE INDEX "price_research_tenant_id_document_id_key"
  ON "price_research"("tenant_id", "document_id");
CREATE INDEX "price_research_process_idx" ON "price_research"("tenant_id", "process_id");

-- 3. Itens da pesquisa.
CREATE TABLE "price_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "price_research_id" UUID NOT NULL,
    "process_item_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "method_override" "price_calculation_method",
    "effective_method" "price_calculation_method",
    "valid_quotations_count" INTEGER NOT NULL DEFAULT 0,
    "mean_price" DECIMAL(18,4),
    "median_price" DECIMAL(18,4),
    "lowest_price" DECIMAL(18,4),
    "highest_price" DECIMAL(18,4),
    "std_deviation" DECIMAL(18,4),
    "coefficient_of_variation" DECIMAL(9,4),
    "recommended_unit_price" DECIMAL(18,4),
    "manual_unit_price" DECIMAL(18,4),
    "manual_justification" TEXT,
    "total_price" DECIMAL(18,2),
    "below_minimum_justification" TEXT,
    "alerts" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "calculated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "price_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_items_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_items_research_fkey"
      FOREIGN KEY ("tenant_id", "price_research_id") REFERENCES "price_research"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "price_items_process_item_fkey"
      FOREIGN KEY ("tenant_id", "process_item_id") REFERENCES "process_items"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "price_items_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_items_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_items_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "price_items_manual" CHECK (
      "method_override" IS DISTINCT FROM 'MANUAL'
      OR ("manual_unit_price" IS NOT NULL AND "manual_justification" IS NOT NULL)
    ),
    CONSTRAINT "price_items_alerts_array" CHECK (jsonb_typeof("alerts") = 'array'),
    CONSTRAINT "price_items_valid_quotations" CHECK ("valid_quotations_count" >= 0),
    CONSTRAINT "price_items_sort_order_range" CHECK ("sort_order" >= 0)
);

CREATE UNIQUE INDEX "price_items_tenant_id_id_key" ON "price_items"("tenant_id", "id");
-- RN-PRICE-03: o item do processo aparece uma única vez por pesquisa.
CREATE UNIQUE INDEX "price_items_research_process_item_key"
  ON "price_items"("tenant_id", "price_research_id", "process_item_id");
-- Uso do item do processo (`ProcessItemUsageRegistry` — ITEM_IN_USE da US-006).
CREATE INDEX "price_items_process_item_idx" ON "price_items"("tenant_id", "process_item_id");

-- 4. Nenhuma linha muda de tenant, processo, documento, pesquisa ou item.
CREATE FUNCTION cf_price_research_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id" THEN
    RAISE EXCEPTION 'price_research: tenant, processo e documento são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_price_research_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "price_research_immutable_columns" BEFORE UPDATE ON "price_research"
  FOR EACH ROW EXECUTE FUNCTION cf_price_research_immutable_columns();

CREATE FUNCTION cf_price_items_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."price_research_id" IS DISTINCT FROM OLD."price_research_id"
     OR NEW."process_item_id" IS DISTINCT FROM OLD."process_item_id" THEN
    RAISE EXCEPTION 'price_items: tenant, pesquisa e item são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_price_items_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "price_items_immutable_columns" BEFORE UPDATE ON "price_items"
  FOR EACH ROW EXECUTE FUNCTION cf_price_items_immutable_columns();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('price_research');
SELECT cf_apply_tenant_rls('price_items');

-- 6. Privilégios mínimos: a pesquisa nunca é apagada (o documento tem exclusão lógica); os itens
-- são removidos pelo PRS-08 (RN-PRICE-11). O worker lê ambos (PDF do mapa comparativo).
GRANT SELECT, INSERT, UPDATE ON "price_research" TO cf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "price_items" TO cf_app;
GRANT SELECT ON "price_research" TO cf_worker;
GRANT SELECT ON "price_items" TO cf_worker;

RESET ROLE;
