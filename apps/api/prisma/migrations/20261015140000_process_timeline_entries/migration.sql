-- US-059 · Timeline do processo (entities.md §4.10 `ProcessTimelineEntry` · events.md §5 ·
-- DEC-025/161 · POL-09). Projeção de leitura gravada só pelo `TimelineProjector`, na transação do
-- caso de uso que publica o evento: imutável (trigger + só INSERT/SELECT), isolada por RLS e
-- idempotente por (tenant_id, source_event_id, type) — o INSERT usa ON CONFLICT DO NOTHING. A FK
-- de process_id → processes entra com a US-001 (a tabela ainda não existe).

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "timeline_visibility" AS ENUM ('STANDARD', 'BUDGET_RESTRICTED');

-- 2. Tabela. `type` é o registro `TimelineEntryType` (packages/types): varchar validado pela
-- aplicação, extensível sem migração; o CHECK só garante o formato.
CREATE TABLE "process_timeline_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(200),
    "actor_department_name" VARCHAR(200),
    "entity_type" VARCHAR(40),
    "entity_id" UUID,
    "movement_id" UUID,
    "params" JSONB NOT NULL DEFAULT '{}',
    "visibility" "timeline_visibility" NOT NULL DEFAULT 'STANDARD',
    "source_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_timeline_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_timeline_entries_type_format" CHECK ("type" ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'),
    CONSTRAINT "process_timeline_entries_params_object" CHECK (jsonb_typeof("params") = 'object'),
    -- Ator de sistema (job de prazos etc.) sem usuário; o nome do job fica em actor_name.
    CONSTRAINT "process_timeline_entries_system_actor"
      CHECK ("actor_type" <> 'SYSTEM' OR "actor_id" IS NULL)
);

-- Alvo das FKs compostas (DEC-081), idempotência (RN-TML-03) e leitura paginada da US-060.
CREATE UNIQUE INDEX "process_timeline_entries_tenant_id_id_key"
  ON "process_timeline_entries"("tenant_id", "id");
CREATE UNIQUE INDEX "process_timeline_entries_source_key"
  ON "process_timeline_entries"("tenant_id", "source_event_id", "type");
CREATE INDEX "process_timeline_entries_process_idx"
  ON "process_timeline_entries"("tenant_id", "process_id", "occurred_at" DESC, "id" DESC);

-- 3. Imutabilidade (entities.md §4.10 · RN-TML-04): UPDATE e DELETE falham para qualquer papel
-- sujeito a triggers — inclusive o dono. A aplicação, além disso, só tem INSERT/SELECT (sem o
-- privilégio de esvaziar a tabela), e o gate de migrações barra esvaziá-la numa migração.
CREATE FUNCTION cf_timeline_entries_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'process_timeline_entries é imutável: % não é permitido', TG_OP
    USING ERRCODE = 'integrity_constraint_violation', HINT = 'Entradas da timeline são imutáveis (US-059).';
END
$fn$;
REVOKE ALL ON FUNCTION cf_timeline_entries_immutable() FROM PUBLIC;

CREATE TRIGGER "process_timeline_entries_immutable" BEFORE UPDATE OR DELETE ON "process_timeline_entries"
  FOR EACH ROW EXECUTE FUNCTION cf_timeline_entries_immutable();

-- 4. RLS (DEC-082 · V-03): leitura e escrita só no tenant da transação.
ALTER TABLE "process_timeline_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "process_timeline_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "process_timeline_entries"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- 5. Privilégios mínimos: só INSERT e SELECT (sem UPDATE/DELETE/TRUNCATE).
GRANT SELECT, INSERT ON "process_timeline_entries" TO cf_app, cf_worker;

RESET ROLE;
