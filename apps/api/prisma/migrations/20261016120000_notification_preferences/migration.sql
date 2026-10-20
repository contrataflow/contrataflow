-- US-113 · Preferências de notificação (entities.md §4 `NotificationPreference` · RN-NTF-22..26).
-- Uma linha por (tenant, usuário, tipo, canal); ausência de linha = padrão do registro
-- `NotificationType` (packages/types). A API grava via ME-06 (upsert; "usar padrão" apaga a linha) e
-- o `NotificationDispatcher` (worker) só lê, a cada despacho. Tabela de tenant (RLS ENABLE + FORCE).

SET ROLE cf_owner;

CREATE TYPE "notification_channel" AS ENUM ('IN_APP', 'EMAIL');

CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notification_type" VARCHAR(60) NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
    -- Só quem tem vínculo no tenant tem preferências nele (RN-NTF-22).
    CONSTRAINT "notification_preferences_membership_fkey"
      FOREIGN KEY ("tenant_id", "user_id")
      REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT,
    -- O tipo é o registro `NotificationType` (validado pela aplicação); o CHECK só garante o formato.
    CONSTRAINT "notification_preferences_type_format"
      CHECK ("notification_type" ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$')
);

-- Alvo das FKs compostas (DEC-081).
CREATE UNIQUE INDEX "notification_preferences_tenant_id_id_key"
  ON "notification_preferences"("tenant_id", "id");
-- RN-NTF-22: idempotência do PUT e base do upsert sob concorrência.
CREATE UNIQUE INDEX "notification_preferences_key"
  ON "notification_preferences"("tenant_id", "user_id", "notification_type", "channel");

SELECT cf_apply_tenant_rls('notification_preferences');

-- Privilégios mínimos: a API lê e grava (restaurar o padrão apaga a linha); o worker só lê.
-- Tenant, usuário, tipo e canal formam a identidade da preferência: só `enabled` muda.
GRANT SELECT, INSERT, DELETE ON "notification_preferences" TO cf_app;
GRANT UPDATE ("enabled", "updated_at") ON "notification_preferences" TO cf_app;
GRANT SELECT ON "notification_preferences" TO cf_worker;

RESET ROLE;
