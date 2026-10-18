-- US-007 · Etiquetas do processo (entities.md §4.4 `Tag` e `ProcessTag` · DEC-040 · P2).
-- `tags`: cadastro do órgão, NUNCA excluído (RN-PROC-86: a desativação mantém as associações).
-- `process_tags`: associação processo × etiqueta; o conjunto é substituído por inteiro (PRC-18) e
-- a aplicação grava só a diferença (inserções/remoções) sob o bloqueio do processo. O limite de 10
-- por processo é regra de aplicação (RN-PROC-88).

SET ROLE cf_owner;

-- 1. Etiquetas.
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "color" VARCHAR(7) NOT NULL DEFAULT '#64748B',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tags_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "tags_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "tags_updated_by_fkey"
      FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- RN-PROC-85: 2 a 40 caracteres após o `trim` e cor `#RRGGBB` (a paleta é regra de aplicação).
    CONSTRAINT "tags_name_length" CHECK (char_length(btrim("name")) BETWEEN 2 AND 40),
    CONSTRAINT "tags_color_format" CHECK ("color" ~ '^#[0-9A-F]{6}$')
);

CREATE UNIQUE INDEX "tags_tenant_id_id_key" ON "tags"("tenant_id", "id");
-- RN-PROC-85: nome único no tenant, sem diferenciar maiúsculas.
CREATE UNIQUE INDEX "tags_tenant_name_key" ON "tags"("tenant_id", lower("name"));

-- A etiqueta não muda de tenant.
CREATE FUNCTION cf_tags_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN
    RAISE EXCEPTION 'tags: o tenant é imutável'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_tags_immutable_columns() FROM PUBLIC;
CREATE TRIGGER "tags_immutable_columns" BEFORE UPDATE ON "tags"
  FOR EACH ROW EXECUTE FUNCTION cf_tags_immutable_columns();

-- 2. Associação processo × etiqueta.
CREATE TABLE "process_tags" (
    "tenant_id" UUID NOT NULL,
    "process_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "process_tags_pkey" PRIMARY KEY ("tenant_id", "process_id", "tag_id"),
    CONSTRAINT "process_tags_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "process_tags_process_fkey"
      FOREIGN KEY ("tenant_id", "process_id") REFERENCES "processes"("tenant_id", "id")
      ON DELETE CASCADE,
    CONSTRAINT "process_tags_tag_fkey"
      FOREIGN KEY ("tenant_id", "tag_id") REFERENCES "tags"("tenant_id", "id")
      ON DELETE RESTRICT,
    CONSTRAINT "process_tags_created_by_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

-- Filtro por etiqueta da lista de processos (US-002, lacuna 2).
CREATE INDEX "process_tags_tag_idx" ON "process_tags"("tenant_id", "tag_id", "process_id");

-- 3. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('tags');
SELECT cf_apply_tenant_rls('process_tags');

-- 4. Privilégios mínimos: `tags` nunca é excluída (sem DELETE); `process_tags` é substituída pela
-- diferença do conjunto (INSERT/DELETE, sem UPDATE). O worker lê (regras e notificações).
GRANT SELECT, INSERT, UPDATE ON "tags" TO cf_app;
GRANT SELECT ON "tags" TO cf_worker;
GRANT SELECT, INSERT, DELETE ON "process_tags" TO cf_app;
GRANT SELECT ON "process_tags" TO cf_worker;

RESET ROLE;
