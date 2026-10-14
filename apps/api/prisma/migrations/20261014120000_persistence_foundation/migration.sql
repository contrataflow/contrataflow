-- US-081 · Fundação da persistência (DEC-080..084 · multi-tenancy.md §5.2 · RN-FND-45..47).
-- Padrão de toda migração: objetos criados como `cf_owner` (SET ROLE), tabela com tenant_id já
-- nasce com RLS ENABLE + FORCE + política `tenant_isolation`, e GRANTs mínimos por papel.

-- 1. Papéis de banco (RN-FND-46). Papéis são do cluster: o bloco é idempotente e só cria o que
-- falta. Em produção a infraestrutura cria os papéis de LOGIN (com senha) antes do primeiro deploy
-- e concede CREATE no schema ao migrador; aqui, então, nada é recriado nem alterado.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_owner') THEN
    -- Dono dos objetos; sem LOGIN e sem BYPASSRLS (o FORCE o submete à RLS).
    CREATE ROLE cf_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_migrator') THEN
    -- Task de deploy: NOINHERIT — só age como dono via SET ROLE cf_owner.
    CREATE ROLE cf_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_app') THEN
    CREATE ROLE cf_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_worker') THEN
    CREATE ROLE cf_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_relay') THEN
    -- BYPASSRLS limitado na prática aos GRANTs: só SELECT/UPDATE em outbox_events (US-082).
    CREATE ROLE cf_relay LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_readonly_report') THEN
    -- Reservado (FA-03): SELECT só em views report_*, sempre com contexto de tenant.
    CREATE ROLE cf_readonly_report LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT pg_has_role('cf_migrator', 'cf_owner', 'MEMBER') THEN
    GRANT cf_owner TO cf_migrator;
  END IF;
  IF NOT has_schema_privilege('cf_owner', 'public', 'CREATE') THEN
    GRANT USAGE, CREATE ON SCHEMA public TO cf_owner;
  END IF;
  -- O migrador cria a própria `_prisma_migrations` (só ele a acessa — multi-tenancy.md §6).
  IF NOT has_schema_privilege('cf_migrator', 'public', 'CREATE') THEN
    GRANT USAGE, CREATE ON SCHEMA public TO cf_migrator;
  END IF;
  -- Papéis das aplicações: USAGE sem CREATE (nenhum DDL).
  IF NOT has_schema_privilege('cf_app', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO cf_app;
  END IF;
  IF NOT has_schema_privilege('cf_worker', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO cf_worker;
  END IF;
  IF NOT has_schema_privilege('cf_relay', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO cf_relay;
  END IF;
  IF NOT has_schema_privilege('cf_readonly_report', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO cf_readonly_report;
  END IF;
END
$roles$;

-- Daqui em diante, tudo pertence a cf_owner (nenhum papel de aplicação é dono de nada).
SET ROLE cf_owner;

-- 2. Imutabilidade de snapshots (DEC-084): função genérica de trigger. Os argumentos são as
-- colunas de conteúdo; mudar qualquer uma delas num UPDATE falha. Aplicada por tabela concreta
-- nas stories de snapshot (ex.: document_versions):
--   CREATE TRIGGER document_versions_immutable BEFORE UPDATE ON document_versions
--     FOR EACH ROW EXECUTE FUNCTION cf_prevent_snapshot_update('content', 'content_hash');
CREATE FUNCTION cf_prevent_snapshot_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  content_column text;
BEGIN
  IF TG_NARGS = 0 THEN
    RAISE EXCEPTION 'cf_prevent_snapshot_update em %: informe as colunas de conteúdo', TG_TABLE_NAME;
  END IF;
  FOREACH content_column IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD) -> content_column) IS DISTINCT FROM (to_jsonb(NEW) -> content_column) THEN
      RAISE EXCEPTION 'snapshot imutável: %.% não pode ser alterada', TG_TABLE_NAME, content_column
        USING ERRCODE = 'integrity_constraint_violation', HINT = 'Crie uma nova versão (DEC-084).';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_prevent_snapshot_update() FROM PUBLIC;

-- 3. outbox_events (entities.md `OutboxEvent` — módulo platform; escrita/relay na US-082).
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "event_type" VARCHAR(80) NOT NULL,
    "routing_key" VARCHAR(120) NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" VARCHAR(60) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "process_id" UUID,
    "payload" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- Parcial (o Prisma não expressa o WHERE; o schema declara o mesmo índice sem ele).
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events"("status", "occurred_at")
  WHERE "status" = 'PENDING';
CREATE INDEX "outbox_events_aggregate_idx"
  ON "outbox_events"("tenant_id", "aggregate_type", "aggregate_id", "occurred_at");

-- RLS (DEC-082 · RN-FND-45): eventos de plataforma (tenant_id nulo) não são visíveis nem
-- graváveis pela aplicação; o relay (BYPASSRLS) lê e atualiza todos.
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbox_events"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- Privilégios mínimos: a aplicação só insere (e lê o que inseriu); quem muda status é o relay.
GRANT SELECT, INSERT ON "outbox_events" TO cf_app, cf_worker;
GRANT SELECT, UPDATE ON "outbox_events" TO cf_relay;

RESET ROLE;
