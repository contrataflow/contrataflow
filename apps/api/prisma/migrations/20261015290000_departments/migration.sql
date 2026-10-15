-- US-102 · Secretarias e setores do órgão (entities.md §4 `Department` · DEC-011/024 · RN-TEN-44..51).
-- Árvore por órgão com caminho materializado (`path` = `/<idRaiz>/…/<id>/`, `depth` 0 na raiz),
-- mantido só pela aplicação (RN-TEN-45) e conferido aqui por checks. A unidade superior é do
-- MESMO órgão por FK composta; a exclusão é física e só sem referências (RN-TEN-51): as FKs que
-- apontam para `departments` são `ON DELETE RESTRICT` — sub-unidades, lotações
-- (`membership_departments`, pendente desde a US-087) e etapas de workflow com unidade fixa
-- (`workflow_stages`, US-040). Processos e `ProcessAccess` ganham as suas FKs na US-001/US-053.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2 `DepartmentType`).
CREATE TYPE "department_type" AS ENUM (
  'SECRETARIAT', 'BOARD', 'DEPARTMENT', 'DIVISION', 'SECTOR', 'COMMITTEE', 'OTHER'
);

-- 2. Tabela.
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_id" UUID,
    "type" "department_type" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "acronym" VARCHAR(30),
    "code" VARCHAR(40),
    "email" CITEXT,
    "phone" VARCHAR(20),
    "head_user_id" UUID,
    "deputy_user_id" UUID,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "departments_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
    CONSTRAINT "departments_head_user_id_fkey"
      FOREIGN KEY ("head_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "departments_deputy_user_id_fkey"
      FOREIGN KEY ("deputy_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "departments_name_length" CHECK (char_length("name") >= 3),
    CONSTRAINT "departments_sort_order_range" CHECK ("sort_order" >= 0),
    -- RN-TEN-44/48 (V-07): uma unidade não é pai de si mesma; titular ≠ substituto (`<>`: nulos
    -- passam — `IS DISTINCT FROM` recusaria a unidade sem titular nem substituto).
    CONSTRAINT "departments_parent_not_self" CHECK ("parent_id" <> "id"),
    CONSTRAINT "departments_head_distinct_deputy" CHECK ("head_user_id" <> "deputy_user_id"),
    -- RN-TEN-45: caminho de ids terminado no próprio id; profundidade = segmentos − 1; raiz ⇔ sem pai.
    CONSTRAINT "departments_path_format"
      CHECK ("path" ~ '^(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})+/$'),
    CONSTRAINT "departments_path_ends_with_id"
      CHECK (right("path", 38) = '/' || "id"::text || '/'),
    CONSTRAINT "departments_depth_matches_path"
      CHECK ("depth" = char_length("path") - char_length(replace("path", '/', '')) - 2),
    CONSTRAINT "departments_root_depth" CHECK (("parent_id" IS NULL) = ("depth" = 0))
);

-- Alvos das FKs compostas (DEC-081): a unidade no tenant e a unidade no órgão (pai do mesmo órgão).
CREATE UNIQUE INDEX "departments_tenant_id_id_key" ON "departments"("tenant_id", "id");
CREATE UNIQUE INDEX "departments_tenant_id_organization_id_id_key"
  ON "departments"("tenant_id", "organization_id", "id");
-- RN-TEN-47 (V-03/V-04): sigla única no órgão; nome único entre irmãos (ou raízes), sem caixa.
CREATE UNIQUE INDEX "departments_acronym_key"
  ON "departments"("tenant_id", "organization_id", "acronym") WHERE "acronym" IS NOT NULL;
CREATE UNIQUE INDEX "departments_sibling_name_key"
  ON "departments"(
    "tenant_id", "organization_id",
    COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name")
  );
-- Subárvore (`path LIKE 'prefixo%'`), filhos, titular e substituto (POL-03/POL-05, fila US-056).
CREATE INDEX "departments_path_idx" ON "departments"("tenant_id", "path" text_pattern_ops);
CREATE INDEX "departments_parent_idx" ON "departments"("tenant_id", "organization_id", "parent_id");
CREATE INDEX "departments_head_user_idx" ON "departments"("tenant_id", "head_user_id");
CREATE INDEX "departments_deputy_user_idx" ON "departments"("tenant_id", "deputy_user_id");

-- 3. FKs. A validação de uma FK que envolve tabela com RLS FORCE (`organizations`,
-- `membership_departments`, `workflow_stages`) roda como o dono, sujeito à RLS: um tenant nulo só
-- para a validação. O Prisma não envolve a migração numa transação — por isso o BEGIN/COMMIT
-- explícito, sem o qual o `set_config(…, true)` se perde antes do `ADD CONSTRAINT` (prisma/README.md).
BEGIN;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);

ALTER TABLE "departments"
  ADD CONSTRAINT "departments_organization_fkey"
  FOREIGN KEY ("tenant_id", "organization_id")
  REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT;
-- MATCH SIMPLE: `parent_id` nulo (raiz) não confere; com pai, o pai é do mesmo tenant E órgão.
ALTER TABLE "departments"
  ADD CONSTRAINT "departments_parent_fkey"
  FOREIGN KEY ("tenant_id", "organization_id", "parent_id")
  REFERENCES "departments"("tenant_id", "organization_id", "id") ON DELETE RESTRICT;

-- Referências que bloqueiam a exclusão física (RN-TEN-51 · V-08).
ALTER TABLE "membership_departments"
  ADD CONSTRAINT "membership_departments_department_fkey"
  FOREIGN KEY ("tenant_id", "department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "workflow_stages"
  ADD CONSTRAINT "workflow_stages_fixed_department_fkey"
  FOREIGN KEY ("tenant_id", "fixed_department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
ALTER TABLE "workflow_stages"
  ADD CONSTRAINT "workflow_stages_approver_fixed_department_fkey"
  FOREIGN KEY ("tenant_id", "approver_fixed_department_id")
  REFERENCES "departments"("tenant_id", "id") ON DELETE RESTRICT;
COMMIT;

-- 4. Imutabilidade: a unidade nunca muda de tenant nem de órgão.
CREATE FUNCTION cf_departments_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    RAISE EXCEPTION 'departments: tenant_id e organization_id são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'A unidade não muda de tenant nem de órgão (US-102).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_departments_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "departments_immutable_columns" BEFORE UPDATE ON "departments"
  FOR EACH ROW EXECUTE FUNCTION cf_departments_immutable_columns();

-- 5. RLS (DEC-082 · RN-TEN-25), depois das FKs.
SELECT cf_apply_tenant_rls('departments');

-- 6. Privilégios mínimos: exclusão física só pela API, sem referências (DEP-09); o worker só lê.
GRANT SELECT, INSERT, UPDATE, DELETE ON "departments" TO cf_app;
GRANT SELECT ON "departments" TO cf_worker;

RESET ROLE;
