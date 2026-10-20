-- US-101 · Órgãos/entidades do tenant (entities.md §4 `Organization` · DEC-011 · RN-TEN-38..43).
-- Tabela de tenant (RLS ENABLE + FORCE), nunca excluída (um órgão inativo continua no histórico —
-- FA-03): a aplicação só tem SELECT/INSERT/UPDATE. Fecha a FK pendente de
-- `tenants.primary_organization_id` (US-087), composta para que o órgão principal seja sempre do
-- próprio tenant. A FK de `logo_attachment_id` → `attachments` entra com a US-068 (a tabela ainda
-- não existe); até lá a API recusa qualquer valor (`REFERENCE_NOT_FOUND`).

SET ROLE cf_owner;

-- 1. Enum (entities.md §2 `OrganizationType`).
CREATE TYPE "organization_type" AS ENUM (
  'DIRECT_ADMINISTRATION', 'FUND', 'AUTARCHY', 'FOUNDATION', 'PUBLIC_COMPANY',
  'MIXED_CAPITAL_COMPANY', 'PUBLIC_CONSORTIUM', 'LEGISLATIVE', 'OTHER'
);

-- 2. Tabela.
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "short_name" VARCHAR(30) NOT NULL,
    "cnpj" VARCHAR(14) NOT NULL,
    "type" "organization_type" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "email" CITEXT,
    "phone" VARCHAR(20),
    "website" VARCHAR(255),
    "address_street" VARCHAR(200),
    "address_number" VARCHAR(20),
    "address_complement" VARCHAR(100),
    "address_district" VARCHAR(100),
    "address_city" VARCHAR(100),
    "address_state" CHAR(2),
    "address_zip_code" CHAR(8),
    "ibge_city_code" CHAR(7),
    "logo_attachment_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizations_tenant_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- RN-TEN-39: sigla em maiúsculas, 2–30 caracteres.
    CONSTRAINT "organizations_short_name_format" CHECK ("short_name" ~ '^[A-Z0-9-]{2,30}$'),
    -- RN-TEN-40: 14 posições (12 numéricas ou alfanuméricas + 2 DVs numéricos); o DV é conferido
    -- na aplicação (`cnpjSchema`).
    CONSTRAINT "organizations_cnpj_format" CHECK ("cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$'),
    CONSTRAINT "organizations_name_length" CHECK (char_length("name") >= 3),
    CONSTRAINT "organizations_website_https" CHECK ("website" IS NULL OR "website" ~ '^https://'),
    CONSTRAINT "organizations_address_state_format"
      CHECK ("address_state" IS NULL OR "address_state" ~ '^[A-Z]{2}$'),
    CONSTRAINT "organizations_address_zip_code_format"
      CHECK ("address_zip_code" IS NULL OR "address_zip_code" ~ '^[0-9]{8}$'),
    CONSTRAINT "organizations_ibge_city_code_format"
      CHECK ("ibge_city_code" IS NULL OR "ibge_city_code" ~ '^[0-9]{7}$'),
    CONSTRAINT "organizations_metadata_object" CHECK (jsonb_typeof("metadata") = 'object')
);

-- Unicidade por tenant (V-02/V-04), alvo das FKs compostas (DEC-081) e listagem do ORG-01.
CREATE UNIQUE INDEX "organizations_tenant_id_cnpj_key" ON "organizations"("tenant_id", "cnpj");
CREATE UNIQUE INDEX "organizations_tenant_id_short_name_key"
  ON "organizations"("tenant_id", "short_name");
CREATE UNIQUE INDEX "organizations_tenant_id_id_key" ON "organizations"("tenant_id", "id");
CREATE INDEX "organizations_active_name_idx" ON "organizations"("tenant_id", "is_active", "name");

-- 3. `tenants.primary_organization_id` → órgão do MESMO tenant (MATCH SIMPLE: nulo não confere —
-- o tenant nasce sem órgão e o seeder `tenancy.primaryOrganization` o preenche).
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_primary_organization_fkey"
  FOREIGN KEY ("id", "primary_organization_id")
  REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT;

-- 4. Imutabilidade: o órgão nunca muda de tenant.
CREATE FUNCTION cf_organizations_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN
    RAISE EXCEPTION 'organizations: tenant_id é imutável'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'O órgão não muda de tenant (US-101).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_organizations_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "organizations_immutable_columns" BEFORE UPDATE ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION cf_organizations_immutable_columns();

-- 5. RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('organizations');

-- 6. Privilégios mínimos: nenhum órgão é excluído (FA-03). O cf_platform não toca em `organizations`
-- (o órgão principal é semeado pelo `TenantTransaction` do tenant novo); só atualiza
-- `tenants.primary_organization_id`, que já está no GRANT de `tenants`.
GRANT SELECT, INSERT, UPDATE ON "organizations" TO cf_app, cf_worker;

RESET ROLE;
