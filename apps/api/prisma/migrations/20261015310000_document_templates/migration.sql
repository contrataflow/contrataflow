-- US-107 · Templates de documento (entities.md §4.7 `DocumentTemplate`/`DocumentTemplateVersion` ·
-- DEC-017/056 · RN-TPL-01..12). Template 1:N versões; a versão 1 nasce em `DRAFT` junto com o
-- template (mesma transação). Só o rascunho é editável: fora de `DRAFT` o conteúdo é imutável por
-- gatilho, inclusive por SQL direto do papel da aplicação (a publicação e a aposentadoria são da
-- US-108). Nada é excluído: a aplicação só tem SELECT/INSERT/UPDATE.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "template_version_status" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- 2. Tabelas.
CREATE TABLE "document_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "current_published_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_templates_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- O tipo é do mesmo tenant (DEC-081).
    CONSTRAINT "document_templates_tenant_id_document_type_id_fkey"
      FOREIGN KEY ("tenant_id", "document_type_id") REFERENCES "document_types"("tenant_id", "id")
      ON DELETE RESTRICT,
    -- RN-TPL-01.
    CONSTRAINT "document_templates_name_length" CHECK (char_length("name") BETWEEN 3 AND 150),
    CONSTRAINT "document_templates_description_length"
      CHECK ("description" IS NULL OR char_length("description") <= 2000)
);
CREATE UNIQUE INDEX "document_templates_tenant_id_id_key" ON "document_templates"("tenant_id", "id");
-- RN-TPL-01 · V-02: nome único por tipo, sem diferenciar maiúsculas.
CREATE UNIQUE INDEX "document_templates_tenant_id_type_lower_name_key"
  ON "document_templates"("tenant_id", "document_type_id", lower("name"));
CREATE INDEX "document_templates_type_idx" ON "document_templates"("tenant_id", "document_type_id");

CREATE TABLE "document_template_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "template_version_status" NOT NULL DEFAULT 'DRAFT',
    "sections" JSONB NOT NULL DEFAULT '[]',
    "layout" JSONB NOT NULL,
    "field_config" JSONB NOT NULL DEFAULT '{}',
    "import_mappings" JSONB,
    "change_notes" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "published_by_id" UUID,
    "retired_at" TIMESTAMPTZ(6),
    "retired_by_id" UUID,
    "content_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_template_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_template_versions_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "document_template_versions_tenant_id_template_id_fkey"
      FOREIGN KEY ("tenant_id", "template_id") REFERENCES "document_templates"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "document_template_versions_version_number_positive" CHECK ("version_number" >= 1),
    -- Formato dos JSONB (o conteúdo é conferido pelos schemas Zod — DEC-056).
    CONSTRAINT "document_template_versions_sections_array" CHECK (jsonb_typeof("sections") = 'array'),
    CONSTRAINT "document_template_versions_layout_object" CHECK (jsonb_typeof("layout") = 'object'),
    CONSTRAINT "document_template_versions_field_config_object"
      CHECK (jsonb_typeof("field_config") = 'object'),
    CONSTRAINT "document_template_versions_import_mappings_object"
      CHECK ("import_mappings" IS NULL OR jsonb_typeof("import_mappings") = 'object'),
    CONSTRAINT "document_template_versions_change_notes_length"
      CHECK ("change_notes" IS NULL OR char_length("change_notes") <= 1000),
    -- Publicada/aposentada sempre com data e hash (US-108); aposentada com data de aposentadoria.
    CONSTRAINT "document_template_versions_published_complete"
      CHECK ("status" = 'DRAFT' OR ("published_at" IS NOT NULL AND "content_hash" IS NOT NULL)),
    CONSTRAINT "document_template_versions_retired_complete"
      CHECK ("status" <> 'RETIRED' OR "retired_at" IS NOT NULL),
    CONSTRAINT "document_template_versions_hash_format"
      CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "document_template_versions_tenant_id_id_key"
  ON "document_template_versions"("tenant_id", "id");
-- Alvo da FK `document_templates.current_published_version_id` (a versão é do próprio template).
CREATE UNIQUE INDEX "document_template_versions_tenant_id_template_id_id_key"
  ON "document_template_versions"("tenant_id", "template_id", "id");
-- Número sequencial por template e no máximo um rascunho (RN-TPL-10).
CREATE UNIQUE INDEX "document_template_versions_number_key"
  ON "document_template_versions"("tenant_id", "template_id", "version_number");
CREATE UNIQUE INDEX "document_template_versions_single_draft_key"
  ON "document_template_versions"("tenant_id", "template_id") WHERE "status" = 'DRAFT';

-- 3. FKs que dependem das duas tabelas.
ALTER TABLE "document_templates"
  ADD CONSTRAINT "document_templates_current_published_version_fkey"
  FOREIGN KEY ("tenant_id", "id", "current_published_version_id")
  REFERENCES "document_template_versions"("tenant_id", "template_id", "id")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
-- `document_types.default_template_id` (US-061) passa a apontar para um template do mesmo tenant.
-- `NOT VALID`: a tabela já tem RLS forçada (a validação das linhas existentes exigiria o contexto
-- de tenant) e nenhuma linha tem template padrão antes da US-108; toda escrita nova é conferida.
ALTER TABLE "document_types"
  ADD CONSTRAINT "document_types_default_template_fkey"
  FOREIGN KEY ("tenant_id", "default_template_id")
  REFERENCES "document_templates"("tenant_id", "id")
  ON DELETE RESTRICT NOT VALID;

-- 4. Imutabilidade.
-- 4.1 RN-TPL-01: o tipo do template não muda depois da criação.
CREATE FUNCTION cf_document_templates_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."document_type_id" IS DISTINCT FROM OLD."document_type_id" THEN
    RAISE EXCEPTION 'document_templates: tenant e tipo de documento são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'O tipo do template não muda depois da criação (US-107 · RN-TPL-01).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_document_templates_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "document_templates_immutable_columns" BEFORE UPDATE ON "document_templates"
  FOR EACH ROW EXECUTE FUNCTION cf_document_templates_immutable_columns();

-- 4.2 RN-TPL-03: só o rascunho muda de conteúdo. Fora de `DRAFT`, só `PUBLISHED → RETIRED` (com
-- `retired_at`/`retired_by_id`, `version` e `updated_*`); o rascunho não vira `RETIRED` sem publicar
-- e não muda de tenant, template ou número.
CREATE FUNCTION cf_template_version_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable CONSTANT text[] := ARRAY['status', 'retired_at', 'retired_by_id', 'version',
                                   'updated_at', 'updated_by_id'];
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."template_id" IS DISTINCT FROM OLD."template_id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number" THEN
      RAISE EXCEPTION 'cf_template_version_immutable: tenant, template e número da versão são imutáveis'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'cf_template_version_immutable: rascunho não pode ser aposentado sem publicar'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED'
     AND (to_jsonb(NEW) - mutable) = (to_jsonb(OLD) - mutable) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'cf_template_version_not_draft: versão % do template é imutável', OLD."id"
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Versão publicada é imutável: inicie uma nova versão (US-107 · RN-TPL-03).';
END
$fn$;
REVOKE ALL ON FUNCTION cf_template_version_immutable() FROM PUBLIC;
CREATE TRIGGER "trg_template_version_immutable" BEFORE UPDATE ON "document_template_versions"
  FOR EACH ROW EXECUTE FUNCTION cf_template_version_immutable();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('document_templates');
SELECT cf_apply_tenant_rls('document_template_versions');

-- 6. Privilégios mínimos: templates e versões não são excluídos; o worker só lê (PDF — US-109).
GRANT SELECT, INSERT, UPDATE ON "document_templates" TO cf_app;
GRANT SELECT, INSERT, UPDATE ON "document_template_versions" TO cf_app;
GRANT SELECT ON "document_templates", "document_template_versions" TO cf_worker;

RESET ROLE;
