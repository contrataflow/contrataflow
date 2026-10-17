-- US-033 · Riscos do processo (entities.md §5 `Risk`/`RiskTreatment` · DEC-021 · RN-RISK-01..10).
-- O risco pertence ao processo (DEC-010); o documento `RISK_MAP` (US-035) é o artefato formal.
-- `code` (`R01`, `R02`…) é único por processo e nunca reaproveitado: as linhas excluídas (só
-- exclusão lógica — o papel da aplicação não tem DELETE) continuam ocupando o código. A atribuição
-- serializa por processo (`pg_advisory_xact_lock`) e o índice único é a rede de segurança.
-- `risk_treatments` nasce aqui para a exclusão em cascata lógica do risco (RN-RISK-10); o CRUD dos
-- tratamentos é da US-034.

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "risk_phase" AS ENUM ('PLANNING', 'SELECTION', 'CONTRACT_MANAGEMENT');
CREATE TYPE "risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'EXTREME');
CREATE TYPE "risk_status" AS ENUM ('OPEN', 'IN_TREATMENT', 'MITIGATED', 'MATERIALIZED', 'CLOSED');
CREATE TYPE "treatment_type" AS ENUM ('PREVENTIVE', 'CONTINGENCY');
CREATE TYPE "treatment_status" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'CANCELED');

-- 2. Riscos.
CREATE TABLE "risks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "category_id" UUID NOT NULL,
    "phase" "risk_phase" NOT NULL,
    "cause" TEXT NOT NULL,
    "consequence" TEXT NOT NULL,
    "probability" SMALLINT NOT NULL,
    "impact" SMALLINT NOT NULL,
    "score" SMALLINT NOT NULL,
    "level" "risk_level" NOT NULL,
    "scale_snapshot" JSONB NOT NULL,
    "owner_id" UUID,
    "owner_department_id" UUID,
    "status" "risk_status" NOT NULL DEFAULT 'OPEN',
    "residual_probability" SMALLINT,
    "residual_impact" SMALLINT,
    "residual_score" SMALLINT,
    "residual_level" "risk_level",
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "risks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "risks_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "risks_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "risks_category_fkey"
      FOREIGN KEY ("tenant_id", "category_id") REFERENCES "catalog_items"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "risks_owner_department_fkey"
      FOREIGN KEY ("tenant_id", "owner_department_id") REFERENCES "departments"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "risks_owner_fkey"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "risks_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "risks_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "risks_deleted_by_fkey"
      FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- RN-RISK-02: "R" + 2 dígitos (a partir de R100, 3 dígitos).
    CONSTRAINT "risks_code_format" CHECK ("code" ~ '^R[0-9]{2,3}$'),
    CONSTRAINT "risks_title_length" CHECK (char_length("title") BETWEEN 3 AND 200),
    CONSTRAINT "risks_description_length" CHECK (
      "description" IS NULL OR char_length("description") <= 2000
    ),
    CONSTRAINT "risks_cause_length" CHECK (char_length("cause") BETWEEN 10 AND 1000),
    CONSTRAINT "risks_consequence_length" CHECK (char_length("consequence") BETWEEN 10 AND 1000),
    -- RN-RISK-03: a faixa vigente (`risk.scale.max` ≤ 5) é conferida pela aplicação.
    CONSTRAINT "risks_grades_positive" CHECK ("probability" > 0 AND "impact" > 0),
    CONSTRAINT "risks_grades_max" CHECK ("probability" <= 5 AND "impact" <= 5),
    CONSTRAINT "risks_score" CHECK ("score" = "probability" * "impact"),
    -- RN-RISK-08: residuais em par; escore residual calculado pela mesma regra.
    CONSTRAINT "risks_residual_pair" CHECK (
      ("residual_probability" IS NULL) = ("residual_impact" IS NULL)
      AND ("residual_probability" IS NULL) = ("residual_score" IS NULL)
      AND ("residual_probability" IS NULL) = ("residual_level" IS NULL)
    ),
    CONSTRAINT "risks_residual_grades" CHECK (
      "residual_probability" IS NULL
      OR ("residual_probability" BETWEEN 1 AND 5 AND "residual_impact" BETWEEN 1 AND 5)
    ),
    CONSTRAINT "risks_residual_score" CHECK (
      "residual_score" IS NULL OR "residual_score" = "residual_probability" * "residual_impact"
    ),
    CONSTRAINT "risks_scale_snapshot_object" CHECK (jsonb_typeof("scale_snapshot") = 'object'),
    CONSTRAINT "risks_deleted_by_with_deleted_at" CHECK (
      "deleted_by_id" IS NULL OR "deleted_at" IS NOT NULL
    )
);

-- Alvo das FKs compostas (DEC-081): `risk_treatments` referencia o risco no tenant.
CREATE UNIQUE INDEX "risks_tenant_id_id_key" ON "risks"("tenant_id", "id");
-- RN-RISK-02: único entre TODOS os riscos do processo, inclusive excluídos (nunca reaproveitado).
CREATE UNIQUE INDEX "risks_code_key" ON "risks"("tenant_id", "process_id", "code");
CREATE INDEX "risks_process_level_idx" ON "risks"("tenant_id", "process_id", "level");

-- 3. Tratamentos (US-034).
CREATE TABLE "risk_treatments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "risk_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "type" "treatment_type" NOT NULL,
    "description" TEXT NOT NULL,
    "responsible_id" UUID,
    "responsible_department_id" UUID,
    "due_date" DATE,
    "status" "treatment_status" NOT NULL DEFAULT 'PLANNED',
    "completed_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "risk_treatments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "risk_treatments_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "risk_treatments_risk_fkey"
      FOREIGN KEY ("tenant_id", "risk_id") REFERENCES "risks"("tenant_id", "id") ON DELETE CASCADE,
    CONSTRAINT "risk_treatments_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "risk_treatments_responsible_department_fkey"
      FOREIGN KEY ("tenant_id", "responsible_department_id")
      REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "risk_treatments_responsible_fkey"
      FOREIGN KEY ("responsible_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "risk_treatments_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "risk_treatments_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "risk_treatments_deleted_by_fkey"
      FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "risk_treatments_done_completed" CHECK (
      "status" <> 'DONE' OR "completed_at" IS NOT NULL
    ),
    CONSTRAINT "risk_treatments_deleted_by_with_deleted_at" CHECK (
      "deleted_by_id" IS NULL OR "deleted_at" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "risk_treatments_tenant_id_id_key" ON "risk_treatments"("tenant_id", "id");
CREATE INDEX "risk_treatments_risk_idx" ON "risk_treatments"("tenant_id", "risk_id");
CREATE INDEX "risk_treatments_responsible_idx"
  ON "risk_treatments"("tenant_id", "responsible_id", "status");

-- 4. O risco não muda de tenant, de processo nem de código (RN-RISK-02); o tratamento, de risco.
CREATE FUNCTION cf_risks_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'risks: tenant, processo e código são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_risks_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "risks_immutable_columns" BEFORE UPDATE ON "risks"
  FOR EACH ROW EXECUTE FUNCTION cf_risks_immutable_columns();

CREATE FUNCTION cf_risk_treatments_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."risk_id" IS DISTINCT FROM OLD."risk_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id" THEN
    RAISE EXCEPTION 'risk_treatments: tenant, risco e processo são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_risk_treatments_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "risk_treatments_immutable_columns" BEFORE UPDATE ON "risk_treatments"
  FOR EACH ROW EXECUTE FUNCTION cf_risk_treatments_immutable_columns();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('risks');
SELECT cf_apply_tenant_rls('risk_treatments');

-- 6. Privilégios mínimos: só exclusão lógica (sem DELETE); o worker lê (mapa de riscos e IA).
GRANT SELECT, INSERT, UPDATE ON "risks" TO cf_app;
GRANT SELECT, INSERT, UPDATE ON "risk_treatments" TO cf_app;
GRANT SELECT ON "risks" TO cf_worker;
GRANT SELECT ON "risk_treatments" TO cf_worker;

RESET ROLE;
