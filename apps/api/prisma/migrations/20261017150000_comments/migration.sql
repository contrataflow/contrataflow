-- US-071 · Comentários no processo e em documentos (entities.md §4.9 `Comment` · DEC-010/034/040).
-- O comentário pertence ao processo (`process_id` obrigatório); o alvo é o processo ou um documento
-- dele, com seção opcional. Respostas têm um nível (`parent_id` aponta um comentário raiz — a
-- regra do nível é conferida pela aplicação, RN-CMT-02). Nada é excluído fisicamente (DEC-034): a
-- exclusão pelo autor e a moderação gravam `deleted_at`/`deleted_by_id` (e `deletion_reason` na
-- moderação) e o papel da aplicação não tem DELETE. O conteúdo é dado potencialmente pessoal (RL-05).

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "comment_target_type" AS ENUM ('PROCESS', 'DOCUMENT');

-- 2. Comentários.
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "target_type" "comment_target_type" NOT NULL,
    "document_id" UUID,
    "section_key" VARCHAR(60),
    "parent_id" UUID,
    "author_id" UUID NOT NULL,
    "body" JSONB NOT NULL,
    "body_text" TEXT NOT NULL,
    "edited_at" TIMESTAMPTZ(6),
    "deletion_reason" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "comments_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    -- FKs compostas (DEC-081): processo, documento e comentário pai do MESMO tenant.
    CONSTRAINT "comments_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "comments_document_fkey"
      FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "comments_author_fkey"
      FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "comments_resolved_by_fkey"
      FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "comments_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "comments_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "comments_deleted_by_fkey"
      FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- RN-CMT-01: documento obrigatório no alvo DOCUMENT; alvo PROCESS sem documento nem seção.
    CONSTRAINT "comments_document_target" CHECK (
      "target_type" <> 'DOCUMENT' OR "document_id" IS NOT NULL
    ),
    CONSTRAINT "comments_process_target" CHECK (
      "target_type" <> 'PROCESS' OR ("document_id" IS NULL AND "section_key" IS NULL)
    ),
    CONSTRAINT "comments_not_own_parent" CHECK ("parent_id" IS DISTINCT FROM "id"),
    CONSTRAINT "comments_section_key_format" CHECK (
      "section_key" IS NULL OR "section_key" ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'
    ),
    -- RN-CMT-05: texto puro derivado com 1–10.000 caracteres; JSON até 100 KB.
    CONSTRAINT "comments_body_text_length" CHECK (char_length("body_text") BETWEEN 1 AND 10000),
    CONSTRAINT "comments_body_object" CHECK (jsonb_typeof("body") = 'object'),
    CONSTRAINT "comments_body_size" CHECK (octet_length("body"::text) <= 102400),
    -- RN-CMT-11: motivo da moderação com 10–1.000 caracteres, só em comentário excluído.
    CONSTRAINT "comments_deletion_reason" CHECK (
      "deletion_reason" IS NULL
      OR ("deleted_at" IS NOT NULL AND char_length("deletion_reason") BETWEEN 10 AND 1000)
    ),
    CONSTRAINT "comments_deleted_by_with_deleted_at" CHECK (
      "deleted_by_id" IS NULL OR "deleted_at" IS NOT NULL
    )
);

-- Alvo das FKs compostas (DEC-081): respostas e menções (US-072) referenciam o comentário.
CREATE UNIQUE INDEX "comments_tenant_id_id_key" ON "comments"("tenant_id", "id");
-- A FK das respostas referencia a própria tabela: entra depois do índice único que ela exige
-- (e antes da RLS, para a validação não depender do contexto de tenant).
ALTER TABLE "comments"
  ADD CONSTRAINT "comments_parent_fkey"
  FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "comments"("tenant_id", "id")
  ON DELETE RESTRICT;
CREATE INDEX "comments_process_created_idx"
  ON "comments"("tenant_id", "process_id", "created_at" DESC);
CREATE INDEX "comments_document_section_idx"
  ON "comments"("tenant_id", "document_id", "section_key");
CREATE INDEX "comments_parent_idx" ON "comments"("tenant_id", "parent_id");
-- RN-CMT-17: paginação das raízes por (`created_at`, `id`) decrescente.
CREATE INDEX "comments_roots_page_idx"
  ON "comments"("tenant_id", "process_id", "created_at" DESC, "id" DESC)
  WHERE "parent_id" IS NULL;

-- 3. O comentário não muda de tenant, processo, alvo, pai nem autor (RN-CMT-02/09).
CREATE FUNCTION cf_comments_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."target_type" IS DISTINCT FROM OLD."target_type"
     OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
     OR NEW."section_key" IS DISTINCT FROM OLD."section_key"
     OR NEW."parent_id" IS DISTINCT FROM OLD."parent_id"
     OR NEW."author_id" IS DISTINCT FROM OLD."author_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'comments: tenant, processo, alvo, pai, autor e criação são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_comments_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "comments_immutable_columns" BEFORE UPDATE ON "comments"
  FOR EACH ROW EXECUTE FUNCTION cf_comments_immutable_columns();

-- 4. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('comments');

-- 5. Privilégios mínimos: só exclusão lógica (sem DELETE); o worker lê (notificações e menções).
GRANT SELECT, INSERT, UPDATE ON "comments" TO cf_app;
GRANT SELECT ON "comments" TO cf_worker;

RESET ROLE;
