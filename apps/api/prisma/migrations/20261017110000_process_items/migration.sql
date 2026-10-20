-- US-006 · Itens da contratação (entities.md §4.4 `ProcessItem` · DEC-019 · RN-PROC-71..84).
-- Item canônico do processo: DFD, ETP, pesquisa de preços e TR referenciam a mesma lista
-- (`DocumentItem`/`PriceItem`, com as stories donas). Filho do agregado `Process`: toda alteração
-- passa pelo `SELECT … FOR UPDATE` do processo e incrementa `processes.version` (RN-PROC-81).
-- Exclusão só lógica (`deleted_at`/`deleted_by_id` — RN-PROC-79); o papel da aplicação não tem
-- DELETE. A renumeração (PRC-17) grava em duas fases (negativos → definitivos) para não violar o
-- índice único parcial de `sequence` dentro da transação.

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "item_kind" AS ENUM ('GOOD', 'SERVICE', 'ENGINEERING_SERVICE', 'WORK');
CREATE TYPE "item_catalog_system" AS ENUM ('CATMAT', 'CATSER', 'OTHER');

-- 2. Tabela.
CREATE TABLE "process_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "lot_number" INTEGER,
    "lot_name" VARCHAR(150),
    "kind" "item_kind" NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "unit_of_measure_id" UUID NOT NULL,
    "catalog_system" "item_catalog_system",
    "catalog_code" VARCHAR(30),
    "reference_quantity" DECIMAL(18,4),
    "reference_quantity_source_document_id" UUID,
    "reference_unit_price" DECIMAL(18,4),
    "reference_unit_price_source_document_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "process_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_items_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_items_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "process_items_unit_of_measure_fkey"
      FOREIGN KEY ("tenant_id", "unit_of_measure_id") REFERENCES "catalog_items"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "process_items_reference_quantity_source_fkey"
      FOREIGN KEY ("tenant_id", "reference_quantity_source_document_id")
      REFERENCES "documents"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "process_items_reference_unit_price_source_fkey"
      FOREIGN KEY ("tenant_id", "reference_unit_price_source_document_id")
      REFERENCES "documents"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "process_items_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_items_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_items_deleted_by_fkey"
      FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- `sequence` negativo só existe no meio da renumeração em duas fases (PRC-17).
    CONSTRAINT "process_items_sequence_not_zero" CHECK ("sequence" <> 0),
    CONSTRAINT "process_items_lot_number_range" CHECK (
      "lot_number" IS NULL OR "lot_number" BETWEEN 1 AND 999
    ),
    CONSTRAINT "process_items_lot_name_needs_number" CHECK (
      "lot_name" IS NULL OR "lot_number" IS NOT NULL
    ),
    CONSTRAINT "process_items_description_length" CHECK (
      char_length("description") BETWEEN 3 AND 2000
    ),
    CONSTRAINT "process_items_reference_quantity_positive" CHECK (
      "reference_quantity" IS NULL OR "reference_quantity" > 0
    ),
    CONSTRAINT "process_items_catalog_code_needs_system" CHECK (
      "catalog_code" IS NULL OR "catalog_system" IS NOT NULL
    ),
    CONSTRAINT "process_items_deleted_by_with_deleted_at" CHECK (
      "deleted_by_id" IS NULL OR "deleted_at" IS NOT NULL
    )
);

-- Alvo das FKs compostas (DEC-081): `document_items`/`price_items` referenciam o item no tenant.
CREATE UNIQUE INDEX "process_items_tenant_id_id_key" ON "process_items"("tenant_id", "id");
-- RN-PROC-73: número único entre os itens não excluídos do processo.
CREATE UNIQUE INDEX "process_items_sequence_key"
  ON "process_items"("tenant_id", "process_id", "sequence")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "process_items_process_idx" ON "process_items"("tenant_id", "process_id");

-- 3. O item não muda de tenant nem de processo.
CREATE FUNCTION cf_process_items_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id" THEN
    RAISE EXCEPTION 'process_items: tenant e processo são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_process_items_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "process_items_immutable_columns" BEFORE UPDATE ON "process_items"
  FOR EACH ROW EXECUTE FUNCTION cf_process_items_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('process_items');

-- 5. Privilégios mínimos: só exclusão lógica (sem DELETE); o worker lê (documentos e IA).
GRANT SELECT, INSERT, UPDATE ON "process_items" TO cf_app;
GRANT SELECT ON "process_items" TO cf_worker;

RESET ROLE;
