-- US-124 · M2-05/M2-06/M2-07 (parcial) — ramos paralelos em execução (entities.md MVP 2 §4.7, §5.1,
-- §5.3–§5.5, §6.7 e §10 · DEC-194 · ADR-005).
--
-- Expand + troca dos índices únicos (contract parcial do M2-06):
--   1. `process_stages`: `stage_type` (snapshot do tipo da `WorkflowStage`, preenchido aqui e então
--      `NOT NULL`), `branch_key` e `split_process_stage_id` (FK composta para o split), check
--      `(branch_key IS NULL) = (split_process_stage_id IS NULL)`.
--   2. `process_branches` (nova, RLS): um ramo aberto por um `PARALLEL_SPLIT`.
--   3. `process_movements.branch_key`.
--   4. `processes.active_stages_count` (1 fora do paralelismo; 0 nos status finais).
--   5. Índices únicos: a etapa ativa única por processo vira "um tronco ativo por processo" +
--      "uma etapa ativa por ramo"; a responsabilidade ativa única por processo vira "uma por etapa".
--
-- As colunas de SLA do M2-05 (`sla_policy_id`, `pause_reason`, `escalation_level`,
-- `last_escalated_at`, `skip_rule_result`) e os valores `MIGRATED`/`SKIPPED` de
-- `process_stage_status` ficam com as stories donas (EP-028/US-127/US-197) — nada aqui os usa.
--
-- Reversível enquanto nenhum ramo tiver sido aberto (o down do M2-06 é recusado depois disso):
--   DROP TABLE "process_branches"; DROP TYPE "process_branch_status";
--   DROP TRIGGER "process_stages_stage_type_default" ON "process_stages";
--   DROP FUNCTION cf_process_stage_type_default();
--   DROP INDEX "process_stages_trunk_active_key", "process_stages_branch_active_key",
--     "process_stages_active_idx", "process_assignments_stage_active_key",
--     "process_assignments_active_idx";
--   CREATE UNIQUE INDEX "process_stages_single_active_key" ON "process_stages"("tenant_id",
--     "process_id") WHERE "status" = 'ACTIVE';
--   CREATE UNIQUE INDEX "process_assignments_single_active_key" ON "process_assignments"(
--     "tenant_id", "process_id") WHERE "is_active";
--   ALTER TABLE "process_stages" DROP COLUMN "stage_type", DROP COLUMN "branch_key",
--     DROP COLUMN "split_process_stage_id";
--   ALTER TABLE "process_movements" DROP COLUMN "branch_key";
--   ALTER TABLE "processes" DROP COLUMN "active_stages_count".

SET ROLE cf_owner;

-- 1. Enum (entities.md MVP 2 §2).
CREATE TYPE "process_branch_status" AS ENUM ('OPEN', 'ARRIVED', 'CANCELED');

-- 2. Colunas novas (nulas; ADD COLUMN sem padrão não reescreve a tabela).
ALTER TABLE "process_stages"
  ADD COLUMN "stage_type" "stage_type",
  ADD COLUMN "branch_key" VARCHAR(60),
  ADD COLUMN "split_process_stage_id" UUID;
-- `NOT VALID`: a coluna acabou de nascer nula (nada a validar) e a checagem inicial rodaria sob a
-- RLS forçada da própria tabela; as linhas novas são conferidas na gravação, como qualquer FK.
ALTER TABLE "process_stages"
  ADD CONSTRAINT "process_stages_split_fkey"
  FOREIGN KEY ("tenant_id", "split_process_stage_id")
  REFERENCES "process_stages"("tenant_id", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "process_stages"
  ADD CONSTRAINT "process_stages_branch_scope"
  CHECK (("branch_key" IS NULL) = ("split_process_stage_id" IS NULL));

ALTER TABLE "process_movements" ADD COLUMN "branch_key" VARCHAR(60);

ALTER TABLE "processes"
  ADD COLUMN "active_stages_count" SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE "processes"
  ADD CONSTRAINT "processes_active_stages_count_range" CHECK ("active_stages_count" >= 0);

-- 3. Dados: o tipo de cada passagem (pela etapa da versão) e a contagem dos processos encerrados.
--    Por tenant, sob a RLS (FORCE vale para o dono).
DO $backfill$
DECLARE
  v_tenant record;
BEGIN
  FOR v_tenant IN SELECT "id" FROM "tenants" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', v_tenant."id"::text, true);
    UPDATE "process_stages" ps
       SET "stage_type" = ws."type"
      FROM "workflow_stages" ws
     WHERE ws."tenant_id" = ps."tenant_id"
       AND ws."id" = ps."workflow_stage_id"
       AND ps."tenant_id" = v_tenant."id"
       AND ps."stage_type" IS NULL;
    UPDATE "processes"
       SET "active_stages_count" = 0
     WHERE "tenant_id" = v_tenant."id"
       AND "status" IN ('CANCELED', 'COMPLETED', 'PUBLISHED')
       AND "active_stages_count" <> 0;
  END LOOP;
END
$backfill$;

ALTER TABLE "process_stages" ALTER COLUMN "stage_type" SET NOT NULL;

-- Quem insere sem o tipo (cargas por SQL, integrações) recebe o da etapa da versão (a aplicação
-- sempre o informa). Roda com os privilégios de quem insere: `cf_app` lê `workflow_stages` sob a RLS.
CREATE FUNCTION cf_process_stage_type_default() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW."stage_type" IS NULL THEN
    SELECT ws."type" INTO NEW."stage_type"
      FROM "workflow_stages" ws
     WHERE ws."tenant_id" = NEW."tenant_id" AND ws."id" = NEW."workflow_stage_id";
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "process_stages_stage_type_default" BEFORE INSERT ON "process_stages"
  FOR EACH ROW EXECUTE FUNCTION cf_process_stage_type_default();

-- 4. Troca dos índices únicos (M2-06): um tronco ativo (etapa comum ou o split) e uma etapa ativa
--    por ramo; a responsabilidade ativa passa a ser por etapa ativa (entities.md MVP 2 §5.3/§5.4).
DROP INDEX "process_stages_single_active_key";
CREATE UNIQUE INDEX "process_stages_trunk_active_key"
  ON "process_stages"("tenant_id", "process_id")
  WHERE "status" = 'ACTIVE' AND "branch_key" IS NULL;
CREATE UNIQUE INDEX "process_stages_branch_active_key"
  ON "process_stages"("tenant_id", "split_process_stage_id", "branch_key")
  WHERE "status" = 'ACTIVE' AND "branch_key" IS NOT NULL;
CREATE INDEX "process_stages_active_idx"
  ON "process_stages"("tenant_id", "process_id") WHERE "status" = 'ACTIVE';

DROP INDEX "process_assignments_single_active_key";
CREATE UNIQUE INDEX "process_assignments_stage_active_key"
  ON "process_assignments"("tenant_id", "process_stage_id") WHERE "is_active";
CREATE INDEX "process_assignments_active_idx"
  ON "process_assignments"("tenant_id", "process_id") WHERE "is_active";

-- 5. Ramos (entities.md MVP 2 §4.7).
CREATE TABLE "process_branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "split_process_stage_id" UUID NOT NULL,
    "branch_key" VARCHAR(60) NOT NULL,
    "status" "process_branch_status" NOT NULL DEFAULT 'OPEN',
    "arrived_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "cancellation_reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "process_branches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_branches_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_branches_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "process_branches_split_fkey"
      FOREIGN KEY ("tenant_id", "split_process_stage_id")
      REFERENCES "process_stages"("tenant_id", "id") ON DELETE CASCADE,
    -- O ciclo de vida (§6.7): `ARRIVED` tem a chegada; `CANCELED`, o cancelamento e o motivo.
    CONSTRAINT "process_branches_arrived"
      CHECK ("status" <> 'ARRIVED' OR "arrived_at" IS NOT NULL),
    CONSTRAINT "process_branches_canceled"
      CHECK ("status" <> 'CANCELED'
             OR ("canceled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL))
);
CREATE UNIQUE INDEX "process_branches_tenant_id_id_key"
  ON "process_branches"("tenant_id", "id");
CREATE UNIQUE INDEX "process_branches_split_branch_key"
  ON "process_branches"("tenant_id", "split_process_stage_id", "branch_key");
CREATE INDEX "process_branches_open_idx"
  ON "process_branches"("tenant_id", "process_id") WHERE "status" = 'OPEN';

-- 6. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('process_branches');

-- 7. Privilégios mínimos (como `process_stages`: sem DELETE — sai pelo CASCADE do processo).
GRANT SELECT, INSERT, UPDATE ON "process_branches" TO cf_app;
GRANT SELECT ON "process_branches" TO cf_worker;

RESET ROLE;
