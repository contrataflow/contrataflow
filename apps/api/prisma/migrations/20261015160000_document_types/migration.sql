-- US-061 · Tipos de documento (entities.md §4.7 `DocumentType` · DEC-017/018/027/028 ·
-- RN-DOC-01..12). Catálogo do tenant: tipos de sistema (semeados no provisionamento — US-099) e
-- tipos personalizados `FREE_TEXT`/`UPLOADED`. Nunca excluído (RN-DOC-11): a aplicação só tem
-- SELECT/INSERT/UPDATE. `code`, `kind`, `system_module` e `is_system` são imutáveis por trigger.
-- A FK de default_template_id → document_templates entra com a US-107 (a tabela ainda não existe).

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "document_kind" AS ENUM ('STRUCTURED', 'FREE_TEXT', 'UPLOADED');
CREATE TYPE "system_document_module" AS ENUM
  ('DFD', 'ETP', 'TERM_OF_REFERENCE', 'RISK_MAP', 'PRICE_RESEARCH');
CREATE TYPE "confidentiality" AS ENUM ('PUBLIC', 'INTERNAL', 'RESTRICTED');

-- 2. Tabela.
CREATE TABLE "document_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "kind" "document_kind" NOT NULL,
    "system_module" "system_document_module",
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "allow_multiple_per_process" BOOLEAN NOT NULL DEFAULT true,
    "numbering_enabled" BOOLEAN NOT NULL DEFAULT true,
    "numbering_mask" VARCHAR(60),
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approval_policy" JSONB,
    "default_template_id" UUID,
    "default_confidentiality" "confidentiality" NOT NULL DEFAULT 'INTERNAL',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_types_pkey" PRIMARY KEY ("id"),
    -- RN-DOC-02.
    CONSTRAINT "document_types_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    -- entities.md §4.7: STRUCTURED ⇔ system_module.
    CONSTRAINT "document_types_structured_module"
      CHECK (("kind" = 'STRUCTURED') = ("system_module" IS NOT NULL)),
    -- RN-DOC-06.
    CONSTRAINT "document_types_approval_policy_required"
      CHECK (NOT "requires_approval" OR "approval_policy" IS NOT NULL),
    CONSTRAINT "document_types_approval_policy_object"
      CHECK ("approval_policy" IS NULL OR jsonb_typeof("approval_policy") = 'object'),
    -- RN-DOC-01/04: estruturado só existe como tipo de sistema, único por processo e sempre ativo.
    CONSTRAINT "document_types_structured_is_system"
      CHECK ("kind" <> 'STRUCTURED' OR "is_system"),
    CONSTRAINT "document_types_structured_single"
      CHECK ("kind" <> 'STRUCTURED' OR NOT "allow_multiple_per_process"),
    CONSTRAINT "document_types_structured_active"
      CHECK ("kind" <> 'STRUCTURED' OR "is_active"),
    CONSTRAINT "document_types_sort_order_range" CHECK ("sort_order" BETWEEN 0 AND 999),
    CONSTRAINT "document_types_description_length"
      CHECK ("description" IS NULL OR char_length("description") <= 2000)
);

-- Unicidade do código por tenant (V-05), alvo das FKs compostas (DEC-081) e listagem do DTY-01.
CREATE UNIQUE INDEX "document_types_tenant_id_code_key" ON "document_types"("tenant_id", "code");
CREATE UNIQUE INDEX "document_types_tenant_id_id_key" ON "document_types"("tenant_id", "id");
CREATE INDEX "document_types_active_order_idx"
  ON "document_types"("tenant_id", "is_active", "sort_order");

-- 3. Imutabilidade (RN-DOC-02): code, kind, system_module e is_system não mudam depois da criação,
-- nem pelo dono — o código sustenta regras, routing keys (`document.created.<type>`) e numeração.
CREATE FUNCTION cf_document_types_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."system_module" IS DISTINCT FROM OLD."system_module"
     OR NEW."is_system" IS DISTINCT FROM OLD."is_system" THEN
    RAISE EXCEPTION 'document_types: code, kind, system_module e is_system são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Código e natureza do tipo de documento não mudam (US-061 · RN-DOC-02).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_document_types_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "document_types_immutable_columns" BEFORE UPDATE ON "document_types"
  FOR EACH ROW EXECUTE FUNCTION cf_document_types_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('document_types');

-- 5. Privilégios mínimos: nenhum tipo é excluído (RN-DOC-11).
GRANT SELECT, INSERT, UPDATE ON "document_types" TO cf_app, cf_worker;

RESET ROLE;
