-- US-003 · Visões salvas da lista de processos (entities.md §4.4 `SavedView` · DEC-040 · P2).
-- Preferência do usuário (sem auditoria nem evento): critérios da lista — `filters` versionado
-- (`{ "v": 1, … }`), `sort` e `columns` — por dono e escopo. Compartilhar expõe os critérios, nunca
-- dados (RN-PROC-37). Exclusão física (preferência pessoal, sem valor de evidência).
-- Lacunas 1 e 2 da story: uma única visão padrão por dono e escopo (índice parcial — a aplicação
-- também garante na transação) e índice das compartilhadas para a listagem de PRC-35.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "saved_view_scope" AS ENUM ('PROCESS_LIST', 'INBOX');

-- 2. Visões.
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "scope" "saved_view_scope" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "filters" JSONB NOT NULL,
    "sort" VARCHAR(120),
    "columns" JSONB NOT NULL,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saved_views_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "saved_views_owner_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "saved_views_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "saved_views_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "saved_views_name_not_blank" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "saved_views_filters_versioned" CHECK (
      jsonb_typeof("filters") = 'object' AND "filters" ? 'v'
    ),
    CONSTRAINT "saved_views_columns_array" CHECK (jsonb_typeof("columns") = 'array')
);

CREATE UNIQUE INDEX "saved_views_tenant_id_id_key" ON "saved_views"("tenant_id", "id");
-- RN-PROC-34 · V-02: nome único por dono e escopo, sem diferenciar maiúsculas.
CREATE UNIQUE INDEX "saved_views_owner_name_key"
  ON "saved_views"("tenant_id", "owner_id", "scope", lower("name"));
-- RN-PROC-36 (lacuna 1): no máximo uma padrão por dono e escopo.
CREATE UNIQUE INDEX "saved_views_owner_default_key"
  ON "saved_views"("tenant_id", "owner_id", "scope") WHERE "is_default";
-- RN-PROC-37 (lacuna 2): compartilhadas do escopo.
CREATE INDEX "saved_views_shared_idx" ON "saved_views"("tenant_id", "scope") WHERE "is_shared";

-- 3. A visão não muda de tenant, de dono nem de escopo.
CREATE FUNCTION cf_saved_views_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
     OR NEW."scope" IS DISTINCT FROM OLD."scope" THEN
    RAISE EXCEPTION 'saved_views: tenant, dono e escopo são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_saved_views_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "saved_views_immutable_columns" BEFORE UPDATE ON "saved_views"
  FOR EACH ROW EXECUTE FUNCTION cf_saved_views_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('saved_views');

-- 5. Privilégios mínimos: CRUD da aplicação (exclusão física); o worker lê (caixa — US-056).
GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_views" TO cf_app;
GRANT SELECT ON "saved_views" TO cf_worker;

RESET ROLE;
