-- US-026 · Registrar fontes de pesquisa e cotações (entities.md §4.8 `PriceSource`/`Quotation` ·
-- RN-PRICE-21..29):
--  * `price_sources` (módulo price-research): a evidência da pesquisa (art. 23, § 1º, da Lei
--    14.133/2021). Os campos exigidos variam pelo tipo (`catalog_items.metadata.requiredFields` do
--    catálogo PRICE_SOURCE_TYPE) e são conferidos na aplicação, lidos no momento da gravação. A
--    remoção é física (RN-PRICE-29 — não pode ser desfeita) e leva as cotações em cascata; por isso
--    não há `deleted_at` (a exclusão lógica de entities.md cedeu à regra da story).
--  * `quotations`: o preço de um item numa fonte, único por (item, fonte), apagado em cascata com a
--    fonte (PRS-12) e com o item (PRS-08 — RN-PRICE-11).

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "quotation_status" AS ENUM ('VALID', 'EXCLUDED');
CREATE TYPE "exclusion_reason" AS ENUM (
  'UNFEASIBLE', 'EXCESSIVE', 'INCONSISTENT', 'EXPIRED', 'NON_COMPLIANT', 'OTHER'
);
CREATE TYPE "outlier_flag" AS ENUM ('NONE', 'LOW', 'HIGH');

-- 2. Fontes.
CREATE TABLE "price_sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "price_research_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "source_type_id" UUID NOT NULL,
    "supplier_id" UUID,
    "description" VARCHAR(300) NOT NULL,
    "quote_date" DATE,
    "accessed_at" TIMESTAMPTZ(6),
    "url" VARCHAR(2048),
    "reference_organization" VARCHAR(250),
    "reference_document" VARCHAR(120),
    "supplier_choice_justification" TEXT,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "price_sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "price_sources_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_sources_research_fkey"
      FOREIGN KEY ("tenant_id", "price_research_id") REFERENCES "price_research"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "price_sources_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    -- Tipo e fornecedor sempre do MESMO tenant (V-02/V-03 — a FK composta impede cruzar tenants).
    CONSTRAINT "price_sources_source_type_fkey"
      FOREIGN KEY ("tenant_id", "source_type_id") REFERENCES "catalog_items"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "price_sources_supplier_fkey"
      FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "price_sources_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_sources_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "price_sources_description_not_blank" CHECK (btrim("description") <> ''),
    -- RN-PRICE-23: endereço sempre https.
    CONSTRAINT "price_sources_url_https" CHECK ("url" IS NULL OR "url" ILIKE 'https://%'),
    CONSTRAINT "price_sources_sort_order_range" CHECK ("sort_order" >= 0)
);

CREATE UNIQUE INDEX "price_sources_tenant_id_id_key" ON "price_sources"("tenant_id", "id");
CREATE INDEX "price_sources_research_idx" ON "price_sources"("tenant_id", "price_research_id");
-- Uso do fornecedor (SUP-05 — RN-PRICE-19).
CREATE INDEX "price_sources_supplier_idx" ON "price_sources"("tenant_id", "supplier_id");

-- 3. Cotações.
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "price_research_id" UUID NOT NULL,
    "price_item_id" UUID NOT NULL,
    "price_source_id" UUID NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "brand_model" VARCHAR(200),
    "status" "quotation_status" NOT NULL DEFAULT 'VALID',
    "exclusion_reason" "exclusion_reason",
    "exclusion_justification" TEXT,
    "excluded_by_id" UUID,
    "excluded_at" TIMESTAMPTZ(6),
    "outlier_flag" "outlier_flag" NOT NULL DEFAULT 'NONE',
    "is_expired" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quotations_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "quotations_research_fkey"
      FOREIGN KEY ("tenant_id", "price_research_id") REFERENCES "price_research"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "quotations_item_fkey"
      FOREIGN KEY ("tenant_id", "price_item_id") REFERENCES "price_items"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "quotations_source_fkey"
      FOREIGN KEY ("tenant_id", "price_source_id") REFERENCES "price_sources"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "quotations_excluded_by_fkey"
      FOREIGN KEY ("excluded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "quotations_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "quotations_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "quotations_unit_price_positive" CHECK ("unit_price" > 0),
    CONSTRAINT "quotations_excluded_reason" CHECK (
      "status" <> 'EXCLUDED'
      OR ("exclusion_reason" IS NOT NULL AND "exclusion_justification" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "quotations_tenant_id_id_key" ON "quotations"("tenant_id", "id");
-- RN-PRICE-25: uma cotação por item em cada fonte.
CREATE UNIQUE INDEX "quotations_item_source_key"
  ON "quotations"("tenant_id", "price_item_id", "price_source_id");
CREATE INDEX "quotations_research_idx" ON "quotations"("tenant_id", "price_research_id");
CREATE INDEX "quotations_source_idx" ON "quotations"("tenant_id", "price_source_id");

-- 4. Nenhuma linha muda de tenant, pesquisa, processo, item ou fonte.
CREATE FUNCTION cf_price_sources_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."price_research_id" IS DISTINCT FROM OLD."price_research_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id" THEN
    RAISE EXCEPTION 'price_sources: tenant, pesquisa e processo são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_price_sources_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "price_sources_immutable_columns" BEFORE UPDATE ON "price_sources"
  FOR EACH ROW EXECUTE FUNCTION cf_price_sources_immutable_columns();

CREATE FUNCTION cf_quotations_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."price_research_id" IS DISTINCT FROM OLD."price_research_id"
     OR NEW."price_item_id" IS DISTINCT FROM OLD."price_item_id"
     OR NEW."price_source_id" IS DISTINCT FROM OLD."price_source_id" THEN
    RAISE EXCEPTION 'quotations: tenant, pesquisa, item e fonte são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_quotations_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "quotations_immutable_columns" BEFORE UPDATE ON "quotations"
  FOR EACH ROW EXECUTE FUNCTION cf_quotations_immutable_columns();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('price_sources');
SELECT cf_apply_tenant_rls('quotations');

-- 6. Privilégios mínimos: fontes e cotações são removidas pelos PRS-12/15 (remoção física). O worker
-- lê ambas (PDF do mapa comparativo — US-031).
GRANT SELECT, INSERT, UPDATE, DELETE ON "price_sources" TO cf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "quotations" TO cf_app;
GRANT SELECT ON "price_sources" TO cf_worker;
GRANT SELECT ON "quotations" TO cf_worker;

RESET ROLE;
