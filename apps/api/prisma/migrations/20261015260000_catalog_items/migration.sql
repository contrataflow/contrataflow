-- US-104 · Catálogos parametrizáveis (entities.md §4 `CatalogItem` · DEC-027 · RN-TEN-59..66).
-- Tabela de tenant (RLS ENABLE + FORCE), nunca excluída: a aplicação só tem SELECT/INSERT/UPDATE
-- (RN-TEN-64 — o ciclo de vida do item é a desativação). Os itens de sistema são semeados no
-- provisionamento (seeder `catalog.items`, US-099) e jamais perdem o `code`.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2 `CatalogType`).
CREATE TYPE "catalog_type" AS ENUM (
  'CONTRACTING_TYPE', 'MODALITY', 'PROCESS_ORIGIN', 'UNIT_OF_MEASURE', 'RISK_CATEGORY',
  'PRICE_SOURCE_TYPE', 'JUDGMENT_CRITERION', 'ATTACHMENT_CATEGORY'
);

-- 2. Tabela.
CREATE TABLE "catalog_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "catalog_type" "catalog_type" NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "label" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "parent_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_items_tenant_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- RN-TEN-59: SCREAMING_SNAKE_CASE.
    CONSTRAINT "catalog_items_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'),
    CONSTRAINT "catalog_items_label_length" CHECK (char_length(btrim("label")) >= 1),
    CONSTRAINT "catalog_items_description_length"
      CHECK ("description" IS NULL OR char_length("description") <= 1000),
    CONSTRAINT "catalog_items_sort_order_range" CHECK ("sort_order" >= 0),
    CONSTRAINT "catalog_items_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "catalog_items_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
    -- RN-TEN-63: o pai não pode ser o próprio item.
    CONSTRAINT "catalog_items_parent_not_self" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);

-- Unicidade do código por tenant e catálogo (V-02); alvo das FKs compostas (DEC-081): o pai é do
-- MESMO tenant e do MESMO catálogo (RN-TEN-63), e outras entidades referenciam o item pelo tenant.
CREATE UNIQUE INDEX "catalog_items_tenant_id_catalog_type_code_key"
  ON "catalog_items"("tenant_id", "catalog_type", "code");
CREATE UNIQUE INDEX "catalog_items_tenant_id_catalog_type_id_key"
  ON "catalog_items"("tenant_id", "catalog_type", "id");
CREATE UNIQUE INDEX "catalog_items_tenant_id_id_key" ON "catalog_items"("tenant_id", "id");
CREATE INDEX "catalog_items_list_idx"
  ON "catalog_items"("tenant_id", "catalog_type", "is_active", "sort_order");

-- MATCH SIMPLE: sem pai (`parent_id` nulo) a FK não confere.
ALTER TABLE "catalog_items"
  ADD CONSTRAINT "catalog_items_parent_fkey"
  FOREIGN KEY ("tenant_id", "catalog_type", "parent_id")
  REFERENCES "catalog_items"("tenant_id", "catalog_type", "id") ON DELETE RESTRICT;

-- 3. Imutabilidade (RN-TEN-59/60): o item nunca muda de tenant, de catálogo nem de código, e
-- `is_system` nunca é alterado depois do INSERT (nem o cliente promove um item a "de sistema").
CREATE FUNCTION cf_catalog_items_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."catalog_type" IS DISTINCT FROM OLD."catalog_type"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."is_system" IS DISTINCT FROM OLD."is_system" THEN
    RAISE EXCEPTION 'catalog_items: tenant_id, catalog_type, code e is_system são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'O item de catálogo não muda de tenant, catálogo, código nem condição de sistema (US-104).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_catalog_items_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "catalog_items_immutable_columns" BEFORE UPDATE ON "catalog_items"
  FOR EACH ROW EXECUTE FUNCTION cf_catalog_items_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('catalog_items');

-- 5. Privilégios mínimos: nenhum item é excluído (RN-TEN-64). O seeder `catalog.items` roda na
-- `TenantTransaction` do tenant novo (cf_app); o worker lê para invalidar caches.
GRANT SELECT, INSERT, UPDATE ON "catalog_items" TO cf_app, cf_worker;

RESET ROLE;
