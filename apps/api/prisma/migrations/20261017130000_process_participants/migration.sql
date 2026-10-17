-- US-012 · Participantes do processo (entities.md §4.4 `ProcessParticipant` · DEC-036 · DEC-024).
-- Acesso explícito por processo, concedido a um usuário OU a uma unidade, sem custódia. A
-- concessão/revogação grava `process_access` (`PARTICIPANT`, `source_id` = participante) na mesma
-- transação. Nunca é apagada: a revogação (manual ou pelo job `participants-expire`) preenche
-- `revoked_at`. Os índices únicos parciais são a salvaguarda de concorrência (RN-PROC-129).

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "participant_role" AS ENUM ('OBSERVER', 'COLLABORATOR', 'CONSULTANT');

-- 2. Tabela.
CREATE TABLE "process_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "user_id" UUID,
    "department_id" UUID,
    "role" "participant_role" NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "reason" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_id" UUID,
    "revocation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_participants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "process_participants_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_participants_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "process_participants_department_fkey"
      FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "process_participants_user_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_participants_granted_by_fkey"
      FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_participants_revoked_by_fkey"
      FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- RN-PROC-126: exatamente um entre usuário e unidade.
    CONSTRAINT "process_participants_one_principal" CHECK (
      ("user_id" IS NULL) <> ("department_id" IS NULL)
    ),
    -- RN-PROC-126/127: consultor é sempre um usuário, com validade.
    CONSTRAINT "process_participants_consultant_expires" CHECK (
      "role" <> 'CONSULTANT' OR "expires_at" IS NOT NULL
    ),
    CONSTRAINT "process_participants_consultant_user" CHECK (
      "role" <> 'CONSULTANT' OR "user_id" IS NOT NULL
    ),
    CONSTRAINT "process_participants_reason_length" CHECK (
      "reason" IS NULL OR char_length("reason") <= 500
    ),
    CONSTRAINT "process_participants_revocation_reason_length" CHECK (
      "revocation_reason" IS NULL OR char_length("revocation_reason") <= 500
    ),
    -- `revoked_by_id` nulo com `revoked_at` = expiração pelo sistema (job `participants-expire`).
    CONSTRAINT "process_participants_revoked_by_with_revoked_at" CHECK (
      "revoked_by_id" IS NULL OR "revoked_at" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "process_participants_tenant_id_id_key"
  ON "process_participants"("tenant_id", "id");
-- RN-PROC-129: no máximo um participante ativo por usuário/unidade no processo.
CREATE UNIQUE INDEX "process_participants_active_user_key"
  ON "process_participants"("tenant_id", "process_id", "user_id")
  WHERE "revoked_at" IS NULL AND "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "process_participants_active_department_key"
  ON "process_participants"("tenant_id", "process_id", "department_id")
  WHERE "revoked_at" IS NULL AND "department_id" IS NOT NULL;
-- Job `participants-expire` (RN-PROC-134): consultores ativos por validade.
CREATE INDEX "process_participants_expiring_idx"
  ON "process_participants"("tenant_id", "expires_at")
  WHERE "revoked_at" IS NULL AND "expires_at" IS NOT NULL;
-- Visibilidade (RN-PROC-135): concessão `PARTICIPANT` → participante pela origem.
CREATE INDEX "process_access_source_idx"
  ON "process_access"("tenant_id", "source_id") WHERE "source_id" IS NOT NULL;

-- 3. O participante não muda de tenant, processo, principal nem papel (RN-PROC-129: revogar e
-- conceder de novo).
CREATE FUNCTION cf_process_participants_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."department_id" IS DISTINCT FROM OLD."department_id"
     OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."granted_by_id" IS DISTINCT FROM OLD."granted_by_id"
     OR NEW."granted_at" IS DISTINCT FROM OLD."granted_at" THEN
    RAISE EXCEPTION 'process_participants: só a revogação altera o participante'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_process_participants_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "process_participants_immutable_columns" BEFORE UPDATE ON "process_participants"
  FOR EACH ROW EXECUTE FUNCTION cf_process_participants_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('process_participants');

-- 5. Privilégios mínimos: sem DELETE (revogação lógica); o worker revoga os consultores vencidos
-- (`participants-expire`) e lê os participantes com `notify` (notificações do processo).
GRANT SELECT, INSERT, UPDATE ON "process_participants" TO cf_app;
GRANT SELECT, UPDATE ON "process_participants" TO cf_worker;

RESET ROLE;
