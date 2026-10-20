-- US-082 · Purga do outbox (DEC-085 · DEC-072 · queues.md §4.8): papel `cf_maintenance`, que
-- apaga os eventos PUBLISHED há mais de 7 dias de todos os tenants. BYPASSRLS limitado na prática
-- aos GRANTs: só SELECT/DELETE em outbox_events — o relay (cf_relay) continua sem DELETE e a
-- aplicação continua sem UPDATE/DELETE. Bloco idempotente e sem senha, como os demais papéis
-- (US-081): em produção a infraestrutura cria o papel e guarda a senha no Secrets Manager.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_maintenance') THEN
    CREATE ROLE cf_maintenance LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT has_schema_privilege('cf_maintenance', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO cf_maintenance;
  END IF;
END
$roles$;

SET ROLE cf_owner;

GRANT SELECT, DELETE ON "outbox_events" TO cf_maintenance;

RESET ROLE;
