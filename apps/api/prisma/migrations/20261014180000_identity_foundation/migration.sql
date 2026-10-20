-- US-087 · Identidade e vínculos (entities.md §4.1 `Tenant`, §4.2 `User`, `TenantMembership`,
-- `MembershipDepartment` · DEC-012/080/081/082). `tenants` nasce aqui porque o login precisa do
-- status da instituição; a US-100 acrescenta as demais funções de plataforma sobre esta tabela.
-- Pendentes em stories seguintes: FK de `tenants.primary_organization_id` → `organizations`
-- (US-101) e de `membership_departments.department_id` → `departments` (US-102).

-- 1. Dono das funções de leitura entre tenants (SECURITY DEFINER): NOLOGIN e BYPASSRLS, sem
-- nenhum outro privilégio. Bloco idempotente (papéis são do cluster); em produção a
-- infraestrutura cria o papel antes do deploy, como os demais (US-081).
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cf_definer') THEN
    CREATE ROLE cf_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
  -- O dono dos objetos transfere a propriedade das funções (ALTER FUNCTION … OWNER TO).
  IF NOT pg_has_role('cf_owner', 'cf_definer', 'MEMBER') THEN
    GRANT cf_definer TO cf_owner;
  END IF;
  IF NOT has_schema_privilege('cf_definer', 'public', 'CREATE') THEN
    GRANT USAGE, CREATE ON SCHEMA public TO cf_definer;
  END IF;
END
$roles$;

SET ROLE cf_owner;

-- 2. Enums (entities.md §2).
CREATE TYPE "tenant_type" AS ENUM ('MUNICIPALITY', 'CITY_COUNCIL', 'AUTARCHY', 'PUBLIC_CONSORTIUM', 'FOUNDATION', 'PUBLIC_COMPANY', 'OTHER');
CREATE TYPE "tenant_status" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DEACTIVATED');
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'BLOCKED', 'DEACTIVATED');
CREATE TYPE "membership_type" AS ENUM ('INTERNAL', 'EXTERNAL', 'SERVICE');
CREATE TYPE "membership_status" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED');

-- 3. tenants — tabela de plataforma (sem tenant_id e sem RLS — DEC-080).
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(250),
    "type" "tenant_type" NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'PROVISIONING',
    "state_code" CHAR(2) NOT NULL,
    "ibge_city_code" CHAR(7),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
    "locale" VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
    "plan" VARCHAR(40) NOT NULL DEFAULT 'STANDARD',
    "primary_organization_id" UUID,
    "activated_at" TIMESTAMPTZ(6),
    "suspended_at" TIMESTAMPTZ(6),
    "suspension_reason" TEXT,
    "deactivated_at" TIMESTAMPTZ(6),
    "offboarding_started_at" TIMESTAMPTZ(6),
    "offboarding_ends_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenants_slug_format" CHECK ("slug" ~ '^[a-z0-9](-?[a-z0-9])*$'),
    CONSTRAINT "tenants_suspension_reason_required"
      CHECK ("status" <> 'SUSPENDED' OR "suspension_reason" IS NOT NULL),
    CONSTRAINT "tenants_offboarding_ends_required"
      CHECK ("status" <> 'OFFBOARDING' OR "offboarding_ends_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- 4. users — identidade global (DEC-012), tabela de plataforma.
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "external_subject" VARCHAR(255),
    "authentik_user_id" VARCHAR(64),
    "email" CITEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR(200) NOT NULL,
    "social_name" VARCHAR(200),
    "cpf_encrypted" BYTEA,
    "cpf_hash" VARCHAR(64),
    "phone" VARCHAR(20),
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "is_platform_operator" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(6),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_external_subject_key" ON "users"("external_subject");
CREATE UNIQUE INDEX "users_authentik_user_id_key" ON "users"("authentik_user_id");
CREATE UNIQUE INDEX "users_cpf_hash_key" ON "users"("cpf_hash");

-- 5. tenant_memberships — vínculo do usuário com o tenant (padrão de tabela de negócio).
CREATE TABLE "tenant_memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "membership_type" NOT NULL DEFAULT 'INTERNAL',
    "status" "membership_status" NOT NULL DEFAULT 'INVITED',
    "job_title" VARCHAR(150),
    "registration_number" VARCHAR(40),
    "invited_by_id" UUID,
    "invited_at" TIMESTAMPTZ(6),
    "invite_token_hash" VARCHAR(64),
    "invite_expires_at" TIMESTAMPTZ(6),
    "activated_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "suspended_at" TIMESTAMPTZ(6),
    "suspension_reason" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "revocation_reason" TEXT,
    "last_access_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_memberships_external_expires"
      CHECK ("type" <> 'EXTERNAL' OR "expires_at" IS NOT NULL),
    CONSTRAINT "tenant_memberships_revoked_at_required"
      CHECK ("status" <> 'REVOKED' OR "revoked_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "tenant_memberships_tenant_id_id_key" ON "tenant_memberships"("tenant_id", "id");
CREATE UNIQUE INDEX "tenant_memberships_tenant_id_user_id_key" ON "tenant_memberships"("tenant_id", "user_id");
CREATE INDEX "tenant_memberships_tenant_id_status_idx" ON "tenant_memberships"("tenant_id", "status");
-- Parcial (o schema Prisma declara o mesmo índice sem o WHERE).
CREATE INDEX "tenant_memberships_external_expiry_idx" ON "tenant_memberships"("tenant_id", "expires_at")
  WHERE "type" = 'EXTERNAL';
-- Leitura dos vínculos do próprio usuário em todos os tenants (cf_user_memberships).
CREATE INDEX "tenant_memberships_user_id_idx" ON "tenant_memberships"("user_id");

ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_revoked_by_id_fkey"
  FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. membership_departments — lotação do vínculo (1 principal + N adicionais).
CREATE TABLE "membership_departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "membership_departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "membership_departments_tenant_id_id_key" ON "membership_departments"("tenant_id", "id");
CREATE UNIQUE INDEX "membership_departments_tenant_id_membership_id_department_i_key"
  ON "membership_departments"("tenant_id", "membership_id", "department_id");
-- Parcial: uma única lotação principal por vínculo.
CREATE UNIQUE INDEX "membership_departments_primary_key" ON "membership_departments"("tenant_id", "membership_id")
  WHERE "is_primary";
CREATE INDEX "membership_departments_tenant_id_department_id_idx"
  ON "membership_departments"("tenant_id", "department_id");

ALTER TABLE "membership_departments" ADD CONSTRAINT "membership_departments_tenant_id_membership_id_fkey"
  FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "tenant_memberships"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_departments" ADD CONSTRAINT "membership_departments_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (DEC-082) só depois das FKs: a validação de uma FK nova consulta a tabela referenciada, e
-- com FORCE ela exigiria `app.tenant_id` na própria migração.
ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_memberships"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE "membership_departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_departments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "membership_departments"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- 7. Leitura dos vínculos do próprio usuário em todos os tenants (ME-04, início de sessão — US-087
-- Lacuna 4). A RLS FORCE impede essa leitura pelo cf_app; a função roda como cf_definer
-- (BYPASSRLS), com search_path fixo, e só responde ao usuário do contexto da transação
-- (`app.user_id`): chamada com outro id não devolve nada. Colunas mínimas (vínculo + nome,
-- status e fuso da instituição), sem dados pessoais.
CREATE FUNCTION cf_user_memberships(p_user_id uuid)
RETURNS TABLE (
  membership_id uuid,
  tenant_id uuid,
  tenant_name varchar,
  tenant_status tenant_status,
  tenant_timezone varchar,
  membership_type membership_type,
  membership_status membership_status,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT m.id, m.tenant_id, t.name, t.status, t.timezone, m.type, m.status, m.expires_at
    FROM public.tenant_memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
   WHERE m.user_id = p_user_id
     AND p_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
   ORDER BY t.name, m.id
$fn$;
REVOKE ALL ON FUNCTION cf_user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cf_user_memberships(uuid) TO cf_app, cf_worker;
ALTER FUNCTION cf_user_memberships(uuid) OWNER TO cf_definer;

-- 8. Privilégios mínimos (multi-tenancy.md §6). `users` só pelo módulo identity; vínculos sem
-- DELETE (revogação é lógica); lotação pode ser removida.
GRANT SELECT ON "tenants" TO cf_app, cf_worker;
GRANT SELECT, INSERT, UPDATE ON "users" TO cf_app;
GRANT SELECT ON "users" TO cf_worker;
GRANT SELECT, INSERT, UPDATE ON "tenant_memberships" TO cf_app, cf_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON "membership_departments" TO cf_app;
GRANT SELECT ON "membership_departments" TO cf_worker;
GRANT SELECT ON "tenants", "tenant_memberships" TO cf_definer;

RESET ROLE;
