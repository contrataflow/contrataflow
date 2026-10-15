-- US-111 · Central de notificações in-app (entities.md §4 `Notification` · events.md §3/§6 ·
-- queues.md §4.2 · DEC-161 · POL-09). Projeção de sistema gravada só pelo `NotificationDispatcher`
-- (worker, fila `notifications`): idempotente por (tenant_id, recipient_id, source_event_id, type)
-- e agrupada em 5 min por `group_key`. A API só lê e marca leitura/arquivamento do próprio
-- destinatário (NTF-01..05). Tabela de tenant (RLS ENABLE + FORCE).

SET ROLE cf_owner;

-- 1. Enums (entities.md §2).
CREATE TYPE "notification_priority" AS ENUM ('NORMAL', 'HIGH');
CREATE TYPE "email_delivery_status" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- 2. Tabela. `type` é o registro `NotificationType` (packages/types): varchar validado pela
-- aplicação, extensível sem migração; o CHECK só garante o formato.
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "priority" "notification_priority" NOT NULL DEFAULT 'NORMAL',
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "link" VARCHAR(500),
    "process_id" UUID,
    "entity_type" VARCHAR(40),
    "entity_id" UUID,
    "source_event_id" UUID NOT NULL,
    "group_key" VARCHAR(120),
    "group_count" INTEGER NOT NULL DEFAULT 1,
    "grouped_event_ids" UUID[] NOT NULL DEFAULT '{}',
    "email_status" "email_delivery_status" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "email_sent_at" TIMESTAMPTZ(6),
    "email_error" VARCHAR(500),
    "read_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    -- Destinatário com vínculo no tenant (entities.md: FK → users com vínculo).
    CONSTRAINT "notifications_recipient_membership_fkey"
      FOREIGN KEY ("tenant_id", "recipient_id")
      REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT,
    CONSTRAINT "notifications_type_format" CHECK ("type" ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'),
    CONSTRAINT "notifications_title_not_blank" CHECK (char_length(btrim("title")) >= 1),
    -- RN-NTF-08: rota web relativa, nunca URL absoluta nem com query (token).
    CONSTRAINT "notifications_link_relative"
      CHECK ("link" IS NULL OR ("link" ~ '^/[A-Za-z0-9_/-]*$' AND "link" !~ '^//')),
    CONSTRAINT "notifications_group_count_positive" CHECK ("group_count" >= 1),
    -- `grouped_event_ids` guarda os demais eventos agregados (máx. 50 — entities.md).
    CONSTRAINT "notifications_grouped_event_ids_max"
      CHECK (cardinality("grouped_event_ids") <= 50 AND "group_count" = 1 + cardinality("grouped_event_ids"))
);

-- Alvo das FKs compostas (DEC-081) e idempotência na reentrega (RN-NTF-03).
CREATE UNIQUE INDEX "notifications_tenant_id_id_key" ON "notifications"("tenant_id", "id");
CREATE UNIQUE INDEX "notifications_source_key"
  ON "notifications"("tenant_id", "recipient_id", "source_event_id", "type");
-- Lista e contagem de não lidas (NTF-01/02).
CREATE INDEX "notifications_recipient_idx"
  ON "notifications"("tenant_id", "recipient_id", "read_at", "created_at" DESC);
-- Fila de e-mail (US-112) e reconciliador do padrão B (queues.md §9).
CREATE INDEX "notifications_email_pending_idx"
  ON "notifications"("email_status") WHERE "email_status" = 'PENDING';
-- Candidata ao agrupamento de 5 min (RN-NTF-04).
CREATE INDEX "notifications_group_idx"
  ON "notifications"("tenant_id", "recipient_id", "group_key", "created_at" DESC)
  WHERE "archived_at" IS NULL;
-- Reentrega de um evento já agregado a uma notificação (RN-NTF-04: idempotência preservada
-- mesmo depois da janela de 5 min ou do arquivamento).
CREATE INDEX "notifications_grouped_event_ids_idx"
  ON "notifications" USING GIN ("grouped_event_ids");

-- 3. Imutabilidade da identidade da notificação: só conteúdo do grupo, leitura, arquivamento e
-- o estado do e-mail mudam depois do INSERT.
CREATE FUNCTION cf_notifications_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."recipient_id" IS DISTINCT FROM OLD."recipient_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
     OR NEW."group_key" IS DISTINCT FROM OLD."group_key"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'notifications: tenant, destinatário, tipo, evento de origem, grupo e criação são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Uma notificação agrupada preserva o primeiro evento (US-111 · RN-NTF-04).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_notifications_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "notifications_immutable_columns" BEFORE UPDATE ON "notifications"
  FOR EACH ROW EXECUTE FUNCTION cf_notifications_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('notifications');

-- 5. Privilégios mínimos: a API lê e só marca leitura/arquivamento (NTF-03..05); o worker grava
-- (dispatcher) e atualiza o estado do e-mail (US-112). Ninguém exclui.
GRANT SELECT ON "notifications" TO cf_app;
GRANT UPDATE ("read_at", "archived_at") ON "notifications" TO cf_app;
GRANT SELECT, INSERT, UPDATE ON "notifications" TO cf_worker;

RESET ROLE;
