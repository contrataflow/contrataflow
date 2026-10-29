-- spec-531 · Chaves de perfil do vínculo (`roleKeys`) derivadas das atribuições vigentes
-- (permissions.md §2 · multi-tenancy.md §6). `cf_user_memberships` (US-087) passa a devolver
-- `role_keys`: as chaves dos perfis ATIVOS das atribuições do vínculo não revogadas e dentro da
-- validade (`valid_from <= now() < valid_until`), sem repetição e em ordem. Só do próprio vínculo:
-- a junção é por `(tenant_id, membership_id)` e `(tenant_id, role_id)` — nunca chaves de outro
-- tenant. Mudar o tipo de retorno exige recriar a função (CREATE OR REPLACE não altera as colunas
-- de saída); quem lê colunas nomeadas segue funcionando durante o deploy. Idempotente.

SET ROLE cf_owner;

-- 1. O dono da função (BYPASSRLS) lê só as colunas necessárias das atribuições e dos perfis.
GRANT SELECT ("tenant_id", "membership_id", "role_id", "valid_from", "valid_until", "revoked_at")
  ON "role_assignments" TO cf_definer;
GRANT SELECT ("tenant_id", "id", "key", "is_active") ON "roles" TO cf_definer;

-- 2. A função, com as mesmas garantias da US-087: SECURITY DEFINER, search_path fixo e resposta
-- só ao usuário do contexto da transação (`app.user_id`).
DROP FUNCTION IF EXISTS cf_user_memberships(uuid);
CREATE FUNCTION cf_user_memberships(p_user_id uuid)
RETURNS TABLE (
  membership_id uuid,
  tenant_id uuid,
  tenant_name varchar,
  tenant_status tenant_status,
  tenant_timezone varchar,
  membership_type membership_type,
  membership_status membership_status,
  expires_at timestamptz,
  role_keys varchar[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT m.id, m.tenant_id, t.name, t.status, t.timezone, m.type, m.status, m.expires_at,
         ARRAY(
           SELECT DISTINCT r.key
             FROM public.role_assignments a
             JOIN public.roles r ON r.tenant_id = a.tenant_id AND r.id = a.role_id
            WHERE a.tenant_id = m.tenant_id
              AND a.membership_id = m.id
              AND a.revoked_at IS NULL
              AND a.valid_from <= now()
              AND (a.valid_until IS NULL OR a.valid_until > now())
              AND r.is_active
            ORDER BY r.key
         )::varchar[]
    FROM public.tenant_memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
   WHERE m.user_id = p_user_id
     AND p_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
   ORDER BY t.name, m.id
$fn$;
REVOKE ALL ON FUNCTION cf_user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cf_user_memberships(uuid) TO cf_app, cf_worker, cf_platform;
ALTER FUNCTION cf_user_memberships(uuid) OWNER TO cf_definer;

RESET ROLE;
