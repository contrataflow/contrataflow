-- US-103 · Configurações gerais do tenant (entities.md §4 `TenantSetting` · RN-TEN-52..58).
-- Tabela de tenant (RLS ENABLE + FORCE), nunca excluída: a aplicação só tem SELECT/INSERT/UPDATE.
-- A chave deve existir no registro tipado e o valor é validado pelo schema Zod da chave (na
-- aplicação); aqui ficam só as garantias estruturais: unicidade por tenant, forma da chave, valor
-- JSON e imutabilidade de tenant e chave. `version` é a concorrência otimista por chave (RN-TEN-54).

SET ROLE cf_owner;

CREATE TABLE "tenant_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_settings_tenant_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- `grupo.nome` com segmentos alfanuméricos (`numbering.process.mask`, `features.minhaFlag`).
    CONSTRAINT "tenant_settings_key_format" CHECK ("key" ~ '^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
    CONSTRAINT "tenant_settings_version_positive" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "tenant_settings_tenant_id_key_key" ON "tenant_settings"("tenant_id", "key");

-- Imutabilidade: a linha nunca muda de tenant nem de chave.
CREATE FUNCTION cf_tenant_settings_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."key" IS DISTINCT FROM OLD."key" THEN
    RAISE EXCEPTION 'tenant_settings: tenant_id e key são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'A configuração não muda de tenant nem de chave (US-103).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_tenant_settings_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "tenant_settings_immutable_columns" BEFORE UPDATE ON "tenant_settings"
  FOR EACH ROW EXECUTE FUNCTION cf_tenant_settings_immutable_columns();

-- RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('tenant_settings');

-- Privilégios mínimos: nenhuma configuração é excluída. O seeder `tenancy.settings` roda na
-- `TenantTransaction` do tenant novo (cf_app); o worker lê para invalidar caches.
GRANT SELECT, INSERT, UPDATE ON "tenant_settings" TO cf_app, cf_worker;

RESET ROLE;
