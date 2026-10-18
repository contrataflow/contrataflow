-- US-072 · Menções em comentários (entities.md §4.9 `Mention` · RN-CMT-21..28 · DEC-040).
-- A menção vive no `body` do comentário (nó `mention`) e gera um registro por alvo DISTINTO e
-- VÁLIDO no commit (RN-CMT-22/23): usuário (`mentioned_user_id`) xor unidade
-- (`mentioned_department_id`). A deduplicação é da aplicação; os índices únicos parciais são a
-- rede de segurança (e o `ON CONFLICT DO NOTHING` de edições concorrentes). `notified_at` é gravado
-- pelo `NotificationDispatcher` (worker) quando a notificação `MENTIONED` sai.

SET ROLE cf_owner;

CREATE TABLE "mentions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "mentioned_user_id" UUID,
    "mentioned_department_id" UUID,
    "notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mentions_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- FKs compostas (DEC-081): comentário, processo e unidade do MESMO tenant.
    CONSTRAINT "mentions_comment_fkey"
      FOREIGN KEY ("tenant_id", "comment_id") REFERENCES "comments"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "mentions_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "mentions_department_fkey"
      FOREIGN KEY ("tenant_id", "mentioned_department_id") REFERENCES "departments"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "mentions_user_fkey"
      FOREIGN KEY ("mentioned_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- RN-CMT-23: exatamente um alvo.
    CONSTRAINT "mentions_single_target" CHECK (
      ("mentioned_user_id" IS NULL) <> ("mentioned_department_id" IS NULL)
    )
);

CREATE UNIQUE INDEX "mentions_tenant_id_id_key" ON "mentions"("tenant_id", "id");
CREATE UNIQUE INDEX "mentions_comment_user_key"
  ON "mentions"("tenant_id", "comment_id", "mentioned_user_id")
  WHERE "mentioned_user_id" IS NOT NULL;
CREATE UNIQUE INDEX "mentions_comment_department_key"
  ON "mentions"("tenant_id", "comment_id", "mentioned_department_id")
  WHERE "mentioned_department_id" IS NOT NULL;
CREATE INDEX "mentions_user_created_idx"
  ON "mentions"("tenant_id", "mentioned_user_id", "created_at" DESC);

-- RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('mentions');

-- Privilégios mínimos: a API grava e lê; o worker lê e marca `notified_at`.
GRANT SELECT, INSERT ON "mentions" TO cf_app;
GRANT SELECT ON "mentions" TO cf_worker;
GRANT UPDATE ("notified_at") ON "mentions" TO cf_worker;

RESET ROLE;
