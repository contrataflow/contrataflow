-- US-106 · Calendário de dias úteis e feriados (entities.md §4 `Holiday` · DEC-031 ·
-- RN-TEN-74..79). Tabela de tenant (RLS ENABLE + FORCE). Feriado de sistema (`is_system`,
-- semeado em `catalog.holidays` — US-099) nunca é excluído, só desativado (RN-TEN-77); o feriado
-- do administrador pode ser excluído (CAL-04), por isso a aplicação tem DELETE.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2 `HolidayScope`).
CREATE TYPE "holiday_scope" AS ENUM ('NATIONAL', 'STATE', 'MUNICIPAL', 'OPTIONAL');

-- 2. Tabela.
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "scope" "holiday_scope" NOT NULL,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "holidays_tenant_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "holidays_name_length" CHECK (char_length(btrim("name")) >= 1),
    CONSTRAINT "holidays_version_positive" CHECK ("version" >= 1)
);

-- RN-TEN-75: unicidade por (tenant, data, nome em minúsculas); escopos diferentes na mesma data
-- com nomes diferentes convivem. Alvo das FKs de outras tabelas pelo tenant (DEC-081).
CREATE UNIQUE INDEX "holidays_tenant_id_date_lower_name_key"
  ON "holidays"("tenant_id", "date", lower("name"));
CREATE UNIQUE INDEX "holidays_tenant_id_id_key" ON "holidays"("tenant_id", "id");
-- Leitura do calendário (CAL-01/05/06 e job de prazos): só feriados ativos por data.
CREATE INDEX "holidays_tenant_id_date_active_idx"
  ON "holidays"("tenant_id", "date") WHERE "is_active";

-- 3. Imutabilidade: o feriado nunca muda de tenant nem de data (para mudar a data, exclui-se e
-- recadastra-se), e `is_system` não é alterado depois do INSERT (o cliente não promove nem
-- rebaixa um feriado). O nome de feriado de sistema também é fixo — é a chave natural do seeder.
CREATE FUNCTION cf_holidays_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."date" IS DISTINCT FROM OLD."date"
     OR NEW."is_system" IS DISTINCT FROM OLD."is_system"
     OR (OLD."is_system" AND NEW."name" IS DISTINCT FROM OLD."name") THEN
    RAISE EXCEPTION 'holidays: tenant_id, date, is_system (e name de feriado de sistema) são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'O feriado não muda de tenant, data nem condição de sistema (US-106).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_holidays_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "holidays_immutable_columns" BEFORE UPDATE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION cf_holidays_immutable_columns();

-- RN-TEN-77: feriado de sistema só é desativado, jamais excluído (defesa em profundidade: a API
-- já responde 409 `CATALOG_ITEM_SYSTEM`).
CREATE FUNCTION cf_holidays_protect_system() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD."is_system" THEN
    RAISE EXCEPTION 'holidays: feriado de sistema não pode ser excluído'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Desative o feriado em vez de excluí-lo (US-106 · RN-TEN-77).';
  END IF;
  RETURN OLD;
END
$fn$;
REVOKE ALL ON FUNCTION cf_holidays_protect_system() FROM PUBLIC;

CREATE TRIGGER "holidays_protect_system" BEFORE DELETE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION cf_holidays_protect_system();

-- 4. RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('holidays');

-- 5. Privilégios: a API grava e exclui (CAL-02..04) e o seeder roda na `TenantTransaction` do
-- tenant; o worker gera o ano seguinte dos recorrentes (job de manutenção) e lê para os prazos.
GRANT SELECT, INSERT, UPDATE, DELETE ON "holidays" TO cf_app;
GRANT SELECT, INSERT ON "holidays" TO cf_worker;

RESET ROLE;
