-- US-100 · Fundação do isolamento por tenant (RN-TEN-25..28 · DEC-076 · multi-tenancy.md §5.2/§5.3).
-- `tenants`, `cf_definer` e `cf_user_memberships` vieram da US-087; aqui entram o papel de
-- plataforma (`cf_platform`, do SystemDbService), a função padrão de RLS para tabelas novas, a
-- leitura de convite entre tenants, as colunas de `tenants` visíveis à aplicação e as políticas de
-- plataforma de `audit_logs`/`outbox_events`. `cf_set_primary_organization` chega com a tabela
-- `organizations` (US-101).

-- 1. Papel do SystemDbService (RN-TEN-26): LOGIN, sem BYPASSRLS. Bloco idempotente (papéis são do
-- cluster); em produção a infraestrutura cria o papel com senha antes do deploy, como os demais.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_platform') THEN
    CREATE ROLE cf_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT has_schema_privilege('cf_platform', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO cf_platform;
  END IF;
END
$roles$;

SET ROLE cf_owner;

-- 2. RLS padrão de tabela nova (RN-TEN-25): ENABLE + FORCE + política `tenant_isolation` com
-- USING e WITH CHECK `tenant_id = current_setting('app.tenant_id')::uuid` — sem `app.tenant_id`
-- a consulta falha com erro (variável ausente) ou no cast (vazia), nunca devolve linhas. Toda
-- migração que cria tabela com `tenant_id` chama `SELECT cf_apply_tenant_rls('tabela')` depois das
-- FKs (prisma/README.md). A política vale para todos os papéis sem BYPASSRLS (cf_app, cf_worker,
-- cf_platform e o dono sob FORCE) — mais restrita que `TO cf_app`. SECURITY INVOKER: só o dono da
-- tabela (cf_owner, pelo migrador) consegue executá-la.
CREATE FUNCTION cf_apply_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = p_table AND attname = 'tenant_id' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'cf_apply_tenant_rls: % não tem a coluna tenant_id', p_table;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = p_table AND polname = 'tenant_isolation'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s '
      'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      p_table);
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION cf_apply_tenant_rls(regclass) FROM PUBLIC;

-- 3. Convite por token (USR-06 · FA-05): leitura entre tenants com colunas mínimas, só pelo
-- SystemDbService (`INVITATION_LOOKUP`). O hash tem formato fixo (SHA-256 em hexadecimal); outro
-- formato não consulta nada.
CREATE FUNCTION cf_find_invitation(p_token_hash varchar)
RETURNS TABLE (
  membership_id uuid,
  tenant_id uuid,
  tenant_name varchar,
  tenant_status tenant_status,
  user_id uuid,
  membership_status membership_status,
  invite_expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT m.id, m.tenant_id, t.name, t.status, m.user_id, m.status, m.invite_expires_at
    FROM public.tenant_memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
   WHERE p_token_hash ~ '^[0-9a-f]{64}$'
     AND m.invite_token_hash = p_token_hash
$fn$;
REVOKE ALL ON FUNCTION cf_find_invitation(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cf_find_invitation(varchar) TO cf_platform;
ALTER FUNCTION cf_find_invitation(varchar) OWNER TO cf_definer;

-- Vínculos do próprio usuário (ME-04, login): também pelo SystemDbService
-- (`USER_MEMBERSHIPS_LOOKUP`); a API segue usando o PlatformTransaction do cf_app (US-087).
GRANT EXECUTE ON FUNCTION cf_user_memberships(uuid) TO cf_platform;

-- 4. `tenants` (multi-tenancy.md §6): a aplicação lê só as colunas não sensíveis — sem plano,
-- motivo e datas de suspensão/desativação; escrita só pelo cf_platform.
REVOKE SELECT ON "tenants" FROM cf_app, cf_worker;
GRANT SELECT (
  "id", "slug", "name", "legal_name", "type", "status", "state_code", "ibge_city_code",
  "timezone", "locale", "primary_organization_id", "activated_at", "offboarding_ends_at",
  "created_at", "updated_at", "version"
) ON "tenants" TO cf_app, cf_worker;
GRANT SELECT, INSERT, UPDATE ON "tenants" TO cf_platform;

-- 5. Auditoria de plataforma (DEC-080 · DEC-139): o cf_platform grava e lê só registros de
-- plataforma (`tenant_id` nulo) e ações de operadores (`actor_type = PLATFORM_OPERATOR`). As
-- políticas da aplicação não o alcançam: o SystemDbService define `app.tenant_id` = UUID nulo.
CREATE POLICY platform_role_select ON "audit_logs" FOR SELECT TO cf_platform
  USING (tenant_id IS NULL OR actor_type = 'PLATFORM_OPERATOR');
CREATE POLICY platform_role_insert ON "audit_logs" FOR INSERT TO cf_platform
  WITH CHECK (tenant_id IS NULL OR actor_type = 'PLATFORM_OPERATOR');
GRANT SELECT, INSERT ON "audit_logs" TO cf_platform;

-- 6. Eventos do agregado `Tenant` (TenantProvisioned, TenantActivated, TenantSuspended — US-099):
-- o cf_platform só grava e lê esses.
CREATE POLICY platform_role_tenant_events ON "outbox_events" FOR INSERT TO cf_platform
  WITH CHECK (aggregate_type = 'Tenant');
CREATE POLICY platform_role_tenant_events_read ON "outbox_events" FOR SELECT TO cf_platform
  USING (aggregate_type = 'Tenant');
GRANT SELECT, INSERT ON "outbox_events" TO cf_platform;

RESET ROLE;
