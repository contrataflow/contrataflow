-- US-073 · Auditoria transacional (entities.md §4 `AuditLog` · DEC-025/080/082/084/085/161 ·
-- ADR-009 · DEC-071). `audit_logs` é append-only (trigger + GRANTs), particionada por mês em
-- `occurred_at` (RANGE, limites em UTC) e isolada por RLS. Registros de plataforma (`tenant_id`
-- nulo) só são gravados numa transação sem `app.tenant_id` e não são legíveis pela aplicação (a
-- leitura de plataforma chega com o papel cf_platform — US-100).

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "actor_type" AS ENUM ('USER', 'SYSTEM', 'PLATFORM_OPERATOR', 'INTEGRATION');
CREATE TYPE "audit_category" AS ENUM ('DATA_CHANGE', 'WORKFLOW', 'ACCESS', 'SECURITY', 'EXPORT', 'CONFIGURATION', 'SYSTEM');
CREATE TYPE "audit_result" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- 2. Tabela particionada. Sem DEFAULT em `id`/`occurred_at`: ambos entram no `row_hash`, que a
-- aplicação calcula antes do INSERT (RN-AUD-08).
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID,
    "actor_type" "actor_type" NOT NULL,
    "actor_user_id" UUID,
    "actor_name" VARCHAR(200),
    "actor_membership_id" UUID,
    "on_behalf_of_user_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "category" "audit_category" NOT NULL,
    "result" "audit_result" NOT NULL,
    "entity_type" VARCHAR(60),
    "entity_id" UUID,
    "process_id" UUID,
    "changes" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "reason_code" VARCHAR(80),
    "ip" INET,
    "user_agent" VARCHAR(512),
    "correlation_id" VARCHAR(64),
    "request_id" VARCHAR(64),
    "session_id_hash" VARCHAR(64),
    "row_hash" VARCHAR(64) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id", "occurred_at"),
    CONSTRAINT "audit_logs_action_format" CHECK ("action" ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
    CONSTRAINT "audit_logs_row_hash_format" CHECK ("row_hash" ~ '^[0-9a-f]{64}$'),
    -- RN-AUD-02 / V-02: negação e falha sempre com motivo.
    CONSTRAINT "audit_logs_reason_required" CHECK ("result" = 'SUCCESS' OR "reason_code" IS NOT NULL),
    -- FA-01: ator de sistema sem usuário nem vínculo (o nome do job fica em actor_name).
    CONSTRAINT "audit_logs_system_actor"
      CHECK ("actor_type" <> 'SYSTEM' OR ("actor_user_id" IS NULL AND "actor_membership_id" IS NULL))
) PARTITION BY RANGE ("occurred_at");

-- Índices de entities.md §4, criados em cada partição.
CREATE INDEX "audit_logs_tenant_occurred_idx" ON "audit_logs"("tenant_id", "occurred_at" DESC);
CREATE INDEX "audit_logs_entity_idx"
  ON "audit_logs"("tenant_id", "entity_type", "entity_id", "occurred_at" DESC);
CREATE INDEX "audit_logs_process_idx" ON "audit_logs"("tenant_id", "process_id", "occurred_at" DESC);
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs"("tenant_id", "actor_user_id", "occurred_at" DESC);
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("tenant_id", "action", "occurred_at" DESC);

-- 3. Imutabilidade (ADR-009 §2): UPDATE/DELETE/TRUNCATE falham para qualquer papel sujeito a
-- triggers — inclusive o dono. A aplicação, além disso, só tem INSERT/SELECT.
CREATE FUNCTION cf_audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_logs é append-only: % não é permitido', TG_OP
    USING ERRCODE = 'integrity_constraint_violation', HINT = 'Registros de auditoria são imutáveis (ADR-009).';
END
$fn$;
REVOKE ALL ON FUNCTION cf_audit_logs_immutable() FROM PUBLIC;

CREATE TRIGGER "audit_logs_immutable" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION cf_audit_logs_immutable();
CREATE TRIGGER "audit_logs_no_truncate" BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION cf_audit_logs_immutable();

-- 4. RLS (DEC-082). Leitura: a política padrão (sem `app.tenant_id` a consulta falha fechada).
-- Escrita: no tenant da transação; registro de plataforma (tenant_id nulo) só numa transação sem
-- tenant — nunca de dentro de um tenant. As políticas de INSERT toleram `app.tenant_id` ausente
-- (NULLIF) porque as duas são avaliadas juntas; sem tenant, nenhuma linha é legível pela aplicação.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs" FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_insert ON "audit_logs" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY platform_insert ON "audit_logs" FOR INSERT
  WITH CHECK (tenant_id IS NULL AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL);

-- 5. Partições mensais (DEC-085). A função cria, de forma idempotente e sob trava consultiva, a
-- partição do mês corrente (UTC) e as dos `p_months_ahead` meses seguintes, cada uma com RLS
-- ENABLE + FORCE e as mesmas políticas (acesso direto à partição também é isolado). Roda como dona
-- da tabela (SECURITY DEFINER) e só sabe criar partições de audit_logs; o job diário da API a
-- chama (FA-03 — partição ausente faz o INSERT falhar e desfaz a transação de negócio).
CREATE FUNCTION cf_audit_ensure_partitions(p_months_ahead integer) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  first_month timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
  month_start timestamp;
  partition_name text;
  created integer := 0;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 12 THEN
    RAISE EXCEPTION 'p_months_ahead fora de 0..12: %', p_months_ahead;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cf_audit_ensure_partitions'));
  FOR offset_months IN 0..p_months_ahead LOOP
    month_start := first_month + make_interval(months => offset_months);
    partition_name := 'audit_logs_' || to_char(month_start, 'YYYY_MM');
    CONTINUE WHEN to_regclass('public.' || partition_name) IS NOT NULL;
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      (month_start AT TIME ZONE 'UTC')::text,
      ((month_start + interval '1 month') AT TIME ZONE 'UTC')::text
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', partition_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR SELECT USING (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      partition_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_insert ON public.%I FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      partition_name
    );
    EXECUTE format(
      'CREATE POLICY platform_insert ON public.%I FOR INSERT WITH CHECK (tenant_id IS NULL AND NULLIF(current_setting(''app.tenant_id'', true), '''') IS NULL)',
      partition_name
    );
    EXECUTE format(
      'CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.cf_audit_logs_immutable()',
      partition_name
    );
    created := created + 1;
  END LOOP;
  RETURN created;
END
$fn$;
REVOKE ALL ON FUNCTION cf_audit_ensure_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cf_audit_ensure_partitions(integer) TO cf_app, cf_worker;

-- Mês corrente e os dois seguintes já na migração; o job diário mantém a folga.
SELECT cf_audit_ensure_partitions(2);

-- 6. Privilégios mínimos: só INSERT e SELECT (sem UPDATE/DELETE/TRUNCATE).
GRANT SELECT, INSERT ON "audit_logs" TO cf_app, cf_worker;

RESET ROLE;
