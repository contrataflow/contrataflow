-- US-119 · Riscos propostos pela IA (entities.md §5 `Risk`/`RiskTreatment` · RN-AI-40/42 · DEC-079).
-- O risco e o tratamento criados pelo RSK-11 guardam a geração de origem (`ai_generation_id`, FK
-- composta no tenant); o risco fica "gerado por IA — revisão pendente" até o RSK-12 gravar
-- `ai_reviewed_at`/`ai_reviewed_by_id` (os tratamentos são revisados com o risco). A origem nunca
-- muda depois de gravada (gatilho), e a revisão só existe em risco gerado por IA.

SET ROLE cf_owner;

-- 1. Riscos.
ALTER TABLE "risks"
  ADD COLUMN "ai_generation_id" UUID,
  ADD COLUMN "ai_reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "ai_reviewed_by_id" UUID,
  ADD CONSTRAINT "risks_ai_generation_fkey"
    FOREIGN KEY ("tenant_id", "ai_generation_id") REFERENCES "ai_generations"("tenant_id", "id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "risks_ai_reviewed_by_fkey"
    FOREIGN KEY ("ai_reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "risks_ai_review_pair"
    CHECK (("ai_reviewed_at" IS NULL) = ("ai_reviewed_by_id" IS NULL)),
  ADD CONSTRAINT "risks_ai_review_needs_generation"
    CHECK ("ai_reviewed_at" IS NULL OR "ai_generation_id" IS NOT NULL);

-- Pendências de revisão do processo (DOC-08 — `RISK_AI_REVIEW_PENDING`).
CREATE INDEX "risks_ai_generation_idx"
  ON "risks"("tenant_id", "process_id")
  WHERE "ai_generation_id" IS NOT NULL AND "deleted_at" IS NULL;

-- 2. Tratamentos.
ALTER TABLE "risk_treatments"
  ADD COLUMN "ai_generation_id" UUID,
  ADD CONSTRAINT "risk_treatments_ai_generation_fkey"
    FOREIGN KEY ("tenant_id", "ai_generation_id") REFERENCES "ai_generations"("tenant_id", "id")
    ON DELETE RESTRICT;

-- 3. A origem da IA é imutável (o risco não "deixa de ter sido gerado por IA").
CREATE OR REPLACE FUNCTION cf_risks_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."ai_generation_id" IS DISTINCT FROM OLD."ai_generation_id" THEN
    RAISE EXCEPTION 'risks: tenant, processo, código e geração de origem são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION cf_risk_treatments_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."risk_id" IS DISTINCT FROM OLD."risk_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."ai_generation_id" IS DISTINCT FROM OLD."ai_generation_id" THEN
    RAISE EXCEPTION 'risk_treatments: tenant, risco, processo e geração de origem são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;

RESET ROLE;
