-- US-021 · Gerenciar alternativas de solução (entities.md §4.8 `EtpAlternative` · DEC-017 ·
-- RN-ETP-18..24 · Lei 14.133/2021, art. 18, §1º, V e VII):
--  * `etp_alternatives` (módulo etp): coleção tipada do ETP — Padrão + SD (exclusão só lógica,
--    RN-ETP-22). `process_id` desnormalizado do ETP (RN-ETP-18).
--  * RN-ETP-20: no máximo uma `RECOMMENDED` por ETP entre as não excluídas (índice único parcial —
--    resolve a corrida de recomendação dupla sem trava explícita).
--  * RN-ETP-18: nome único por ETP sem diferenciar maiúsculas, entre as não excluídas (índice de
--    expressão `lower(name)`).
--  * RN-ETP-19: decisão diferente de `UNDER_ANALYSIS` sempre com justificativa (CHECK).
--  * `etps.recommended_alternative_id` ganha a FK prevista na US-019.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "alternative_decision" AS ENUM ('UNDER_ANALYSIS', 'RECOMMENDED', 'DISCARDED');

-- 2. Alternativas.
CREATE TABLE "etp_alternatives" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "etp_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" JSONB NOT NULL,
    "advantages" JSONB,
    "disadvantages" JSONB,
    "estimated_cost" DECIMAL(18,2),
    "risk_level" "risk_level",
    "observations" TEXT,
    "decision" "alternative_decision" NOT NULL DEFAULT 'UNDER_ANALYSIS',
    "decision_justification" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "etp_alternatives_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "etp_alternatives_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "etp_alternatives_etp_fkey"
      FOREIGN KEY ("tenant_id", "etp_id") REFERENCES "etps"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "etp_alternatives_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "etp_alternatives_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "etp_alternatives_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "etp_alternatives_deleted_by_fkey"
      FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "etp_alternatives_name_not_blank" CHECK (btrim("name") <> ''),
    CONSTRAINT "etp_alternatives_decision_justified" CHECK (
      "decision" = 'UNDER_ANALYSIS' OR "decision_justification" IS NOT NULL
    ),
    CONSTRAINT "etp_alternatives_estimated_cost_not_negative" CHECK (
      "estimated_cost" IS NULL OR "estimated_cost" >= 0
    ),
    CONSTRAINT "etp_alternatives_deleted_by_with_deleted_at" CHECK (
      "deleted_by_id" IS NULL OR "deleted_at" IS NOT NULL
    )
);

-- Alvo da FK composta de `etps.recommended_alternative_id` (DEC-081).
CREATE UNIQUE INDEX "etp_alternatives_tenant_id_id_key" ON "etp_alternatives"("tenant_id", "id");
CREATE INDEX "etp_alternatives_etp_idx" ON "etp_alternatives"("tenant_id", "etp_id", "sort_order");
-- RN-ETP-20: no máximo uma recomendada por ETP.
CREATE UNIQUE INDEX "etp_alternatives_one_recommended_key"
  ON "etp_alternatives"("tenant_id", "etp_id")
  WHERE "decision" = 'RECOMMENDED' AND "deleted_at" IS NULL;
-- RN-ETP-18: nome único por ETP, sem diferenciar maiúsculas.
CREATE UNIQUE INDEX "etp_alternatives_name_key"
  ON "etp_alternatives"("tenant_id", "etp_id", lower("name"))
  WHERE "deleted_at" IS NULL;

-- 3. A alternativa nunca muda de tenant, ETP ou processo.
CREATE FUNCTION cf_etp_alternatives_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."etp_id" IS DISTINCT FROM OLD."etp_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id" THEN
    RAISE EXCEPTION 'etp_alternatives: tenant, ETP e processo são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_etp_alternatives_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "etp_alternatives_immutable_columns" BEFORE UPDATE ON "etp_alternatives"
  FOR EACH ROW EXECUTE FUNCTION cf_etp_alternatives_immutable_columns();

-- 4. A recomendada do cabeçalho do ETP (RN-ETP-21) aponta para uma alternativa do tenant.
ALTER TABLE "etps"
  ADD CONSTRAINT "etps_recommended_alternative_fkey"
  FOREIGN KEY ("tenant_id", "recommended_alternative_id")
  REFERENCES "etp_alternatives"("tenant_id", "id") ON DELETE RESTRICT;

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('etp_alternatives');

-- 6. Privilégios mínimos: só exclusão lógica (sem DELETE); o worker lê (PDF e snapshot do ETP).
GRANT SELECT, INSERT, UPDATE ON "etp_alternatives" TO cf_app;
GRANT SELECT ON "etp_alternatives" TO cf_worker;

RESET ROLE;
