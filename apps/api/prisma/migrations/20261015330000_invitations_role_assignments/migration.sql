-- US-091 · Convite de usuário e ativação do vínculo (entities.md §4.2 `TenantMembership` e
-- `RoleAssignment` · RN-IAM-46..53 · DEC-012/134).
-- 1. `tenant_memberships.invite_resend_count`: limite de 5 reenvios por convite (RN-IAM-53).
-- 2. `role_assignments` (módulo access): o perfil inicial informado no convite é gravado já com o
--    vínculo `INVITED` (RN-IAM-51); a gestão contínua das atribuições é da US-096 e a leitura das
--    permissões efetivas, da US-097. Tabela de tenant "Padrão" (RLS ENABLE + FORCE).

SET ROLE cf_owner;

-- 1. Reenvios do convite (zerado a cada novo convite do mesmo vínculo).
ALTER TABLE "tenant_memberships"
  ADD COLUMN "invite_resend_count" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "tenant_memberships_invite_resend_count_range"
    CHECK ("invite_resend_count" BETWEEN 0 AND 5);

-- Aceite por hash (USR-06 · `cf_find_invitation`): o token é único enquanto pendente.
CREATE UNIQUE INDEX "tenant_memberships_invite_token_hash_key"
  ON "tenant_memberships"("invite_token_hash") WHERE "invite_token_hash" IS NOT NULL;

-- 2. Escopo da atribuição (entities.md §2 `ScopeType`).
CREATE TYPE "scope_type" AS ENUM ('TENANT', 'ORGANIZATION', 'DEPARTMENT', 'OWN_DEPARTMENTS');

CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "scope_type" NOT NULL,
    "scope_organization_id" UUID,
    "scope_department_id" UUID,
    "include_subtree" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(6),
    "granted_by_id" UUID NOT NULL,
    "reason" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "revocation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "role_assignments_scope_shape" CHECK (
      ("scope_type" = 'TENANT' AND "scope_organization_id" IS NULL AND "scope_department_id" IS NULL)
      OR ("scope_type" = 'ORGANIZATION' AND "scope_organization_id" IS NOT NULL AND "scope_department_id" IS NULL)
      OR ("scope_type" = 'DEPARTMENT' AND "scope_department_id" IS NOT NULL)
      OR ("scope_type" = 'OWN_DEPARTMENTS' AND "scope_organization_id" IS NULL AND "scope_department_id" IS NULL)
    ),
    CONSTRAINT "role_assignments_validity" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
    CONSTRAINT "role_assignments_membership_fkey"
      FOREIGN KEY ("tenant_id", "membership_id")
      REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "role_assignments_role_fkey"
      FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "role_assignments_scope_organization_fkey"
      FOREIGN KEY ("tenant_id", "scope_organization_id")
      REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "role_assignments_scope_department_fkey"
      FOREIGN KEY ("tenant_id", "scope_department_id")
      REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT,
    CONSTRAINT "role_assignments_granted_by_fkey"
      FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "role_assignments_revoked_by_fkey"
      FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "role_assignments_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "role_assignments_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "role_assignments_tenant_id_id_key" ON "role_assignments"("tenant_id", "id");
-- Uma atribuição vigente por (vínculo, perfil, escopo) — entities.md `RoleAssignment`.
CREATE UNIQUE INDEX "role_assignments_active_key" ON "role_assignments"(
  "tenant_id", "membership_id", "role_id", "scope_type",
  COALESCE("scope_organization_id", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("scope_department_id", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "revoked_at" IS NULL;
CREATE INDEX "role_assignments_membership_idx"
  ON "role_assignments"("tenant_id", "membership_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "role_assignments_role_idx" ON "role_assignments"("tenant_id", "role_id");

-- 3. RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('role_assignments');

-- 4. Privilégios mínimos: revogação é lógica (sem DELETE); o worker só lê (cache de permissões).
GRANT SELECT, INSERT, UPDATE ON "role_assignments" TO cf_app;
GRANT SELECT ON "role_assignments" TO cf_worker;

RESET ROLE;
