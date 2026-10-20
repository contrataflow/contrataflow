-- US-025 · Cadastro de fornecedores (entities.md §4 `Supplier` · DEC-010/034/086 · RN-PRICE-14..20).
-- Recurso do tenant, sem `process_id` (DEC-010). O CPF é dado pessoal (DEC-086): a coluna
-- `document_number` guarda a forma MASCARADA (`***.456.789-**`), o número vai cifrado em
-- `document_number_encrypted` (AES-256-GCM, envelope — só CPF) e a unicidade/busca usa o blind index
-- HMAC em `document_number_hash`. CNPJ (numérico ou alfanumérico) e estrangeiro ficam em claro.
-- Exclusão só lógica (`deleted_at` — RN-PRICE-19); o papel da aplicação não tem DELETE. As FKs de
-- `price_sources` para esta tabela entram com a US-026.
-- Extensões `citext`/`pg_trgm`/`unaccent` vêm do init (RN-FND-14).

SET ROLE cf_owner;

-- 1. Enum (entities.md §2 `SupplierDocumentType`).
CREATE TYPE "supplier_document_type" AS ENUM ('CNPJ', 'CPF', 'FOREIGN');

-- 2. Tabela.
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_type" "supplier_document_type" NOT NULL,
    "document_number" VARCHAR(20) NOT NULL,
    "document_number_encrypted" BYTEA,
    "document_number_hash" VARCHAR(64) NOT NULL,
    "legal_name" VARCHAR(250) NOT NULL,
    "trade_name" VARCHAR(250),
    "email" CITEXT,
    "phone" VARCHAR(20),
    "website" VARCHAR(255),
    "contact_name" VARCHAR(150),
    "address_street" VARCHAR(200),
    "address_number" VARCHAR(20),
    "address_complement" VARCHAR(100),
    "address_district" VARCHAR(100),
    "address_city" VARCHAR(100),
    "address_state" CHAR(2),
    "address_zip_code" CHAR(8),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suppliers_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "suppliers_legal_name_length" CHECK (char_length("legal_name") BETWEEN 2 AND 250),
    CONSTRAINT "suppliers_document_number_not_empty" CHECK (char_length("document_number") >= 1),
    -- Blind index: HMAC-SHA-256 em hexadecimal (DEC-086).
    CONSTRAINT "suppliers_document_hash_format" CHECK ("document_number_hash" ~ '^[0-9a-f]{64}$'),
    -- RN-PRICE-16: CPF sempre mascarado e cifrado; os demais tipos nunca têm número cifrado.
    CONSTRAINT "suppliers_cpf_protected" CHECK (
      ("document_type" = 'CPF'
        AND "document_number_encrypted" IS NOT NULL
        AND "document_number" ~ '^\*\*\*\.[0-9]{3}\.[0-9]{3}-\*\*$')
      OR ("document_type" <> 'CPF' AND "document_number_encrypted" IS NULL)
    ),
    -- RN-PRICE-15: CNPJ = 12 caracteres [0-9A-Z] + 2 dígitos verificadores (o DV é da aplicação).
    CONSTRAINT "suppliers_cnpj_format" CHECK (
      "document_type" <> 'CNPJ' OR "document_number" ~ '^[0-9A-Z]{12}[0-9]{2}$'
    )
);

-- Alvo das FKs compostas (DEC-081): `price_sources` (US-026) referencia o fornecedor no tenant.
CREATE UNIQUE INDEX "suppliers_tenant_id_id_key" ON "suppliers"("tenant_id", "id");
-- RN-PRICE-17 (V-04): um documento por tipo e tenant entre os não excluídos; excluído libera o número.
CREATE UNIQUE INDEX "suppliers_document_key"
  ON "suppliers"("tenant_id", "document_type", "document_number_hash")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "suppliers_document_number_idx" ON "suppliers"("tenant_id", "document_number");
CREATE INDEX "suppliers_active_name_idx" ON "suppliers"("tenant_id", "is_active", "legal_name")
  WHERE "deleted_at" IS NULL;
-- Busca textual da lista (SCR-107): contém, sem diferenciar maiúsculas (`ILIKE '%…%'`).
CREATE INDEX "suppliers_legal_name_trgm_idx" ON "suppliers" USING GIN ("legal_name" gin_trgm_ops);
CREATE INDEX "suppliers_trade_name_trgm_idx" ON "suppliers" USING GIN ("trade_name" gin_trgm_ops);

-- 3. O fornecedor não muda de tenant nem de documento (RN-PRICE-14): o documento é imutável.
CREATE FUNCTION cf_suppliers_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."document_type" IS DISTINCT FROM OLD."document_type"
     OR NEW."document_number" IS DISTINCT FROM OLD."document_number"
     OR NEW."document_number_hash" IS DISTINCT FROM OLD."document_number_hash"
     OR NEW."document_number_encrypted" IS DISTINCT FROM OLD."document_number_encrypted" THEN
    RAISE EXCEPTION 'suppliers: tenant e documento são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Cadastre um novo fornecedor (RN-PRICE-14).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_suppliers_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "suppliers_immutable_columns" BEFORE UPDATE ON "suppliers"
  FOR EACH ROW EXECUTE FUNCTION cf_suppliers_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('suppliers');

-- 5. Privilégios mínimos: só exclusão lógica (sem DELETE); o worker lê (pesquisa de preços — US-026).
GRANT SELECT, INSERT, UPDATE ON "suppliers" TO cf_app;
GRANT SELECT ON "suppliers" TO cf_worker;

RESET ROLE;
