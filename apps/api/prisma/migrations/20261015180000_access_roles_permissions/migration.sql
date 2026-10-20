-- US-094 · Catálogo de permissões e perfis padrão (entities.md §4.2 `Permission`, `Role`,
-- `RolePermission` · permissions.md §2/§3 · DEC-035/DEC-134 · RN-IAM-73..78).
-- `permissions` é tabela de PLATAFORMA (catálogo global, sem tenant_id): sincronizada aqui a partir
-- de `packages/types/src/permissions.ts` (upsert por `code`, nunca DELETE — a FK de
-- role_permissions impede remover código em uso). Permissão nova = migração nova com o mesmo
-- upsert. `roles`/`role_permissions` são do tenant (RLS) e semeadas pelo provisionamento (US-099,
-- seeder `access.defaultRoles`), nunca por esta migração.

SET ROLE cf_owner;

-- 1. Enum (entities.md §2).
CREATE TYPE "permission_risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- 2. Catálogo global.
CREATE TABLE "permissions" (
    "code" VARCHAR(80) NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL,
    "risk_level" "permission_risk_level" NOT NULL,
    "scopable" BOOLEAN NOT NULL,
    "is_deprecated" BOOLEAN NOT NULL DEFAULT false,
    "introduced_in" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code"),
    -- DEC-001: RESOURCE_ACTION.
    CONSTRAINT "permissions_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$')
);

-- 3. Sincronização do catálogo do MVP 1 (68 permissões — RN-IAM-73). Só toca a linha quando algo
-- mudou, para o `updated_at` refletir alterações reais.
INSERT INTO "permissions"
  ("code", "module", "name", "description", "risk_level", "scopable", "is_deprecated", "introduced_in")
VALUES
  ('PROCESS_VIEW', 'process', 'Visualizar processos',
   'Ver lista, detalhe, documentos, timeline e tramitações dos processos visíveis',
   'LOW', true, false, 'MVP1'),
  ('PROCESS_CREATE', 'process', 'Criar processo',
   'Criar processo cuja unidade solicitante está no escopo',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_UPDATE', 'process', 'Editar processo',
   'Editar dados, itens e etiquetas — exige custódia (POL-01)',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_FORWARD', 'process', 'Encaminhar processo',
   'Encaminhar o processo a outra unidade — exige custódia (POL-01)',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_RETURN', 'process', 'Devolver processo',
   'Devolver o processo à unidade anterior — exige custódia (POL-01)',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_CLAIM', 'process', 'Assumir processo',
   'Processo na fila de unidade em que o usuário é lotado (POL-04)',
   'LOW', true, false, 'MVP1'),
  ('PROCESS_ASSIGN', 'process', 'Atribuir responsável',
   'Atribuir/reatribuir dentro da unidade atual (POL-05)',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_SUSPEND', 'process', 'Suspender e retomar',
   'Suspender e retomar a tramitação do processo (POL-07)',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_CANCEL', 'process', 'Cancelar processo',
   'Cancelar o processo, com justificativa (POL-06)',
   'HIGH', true, false, 'MVP1'),
  ('PROCESS_COMPLETE', 'process', 'Concluir processo',
   'Concluir o planejamento da contratação (POL-08)',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_DUPLICATE', 'process', 'Duplicar processo',
   'Requer também PROCESS_CREATE para a unidade solicitante do novo processo',
   'LOW', true, false, 'MVP1'),
  ('PROCESS_MANAGE_PARTICIPANTS', 'process', 'Gerenciar participantes',
   'Incluir e remover participantes do processo (POL-10)',
   'MEDIUM', true, false, 'MVP1'),
  ('PROCESS_FOLLOW', 'process', 'Seguir processo',
   'Torna-se OBSERVER de si mesmo',
   'LOW', true, false, 'MVP1'),
  ('PROCESS_VIEW_CONFIDENTIAL_BUDGET', 'process', 'Ver orçamento sigiloso',
   'Ver valores do orçamento estimado marcado como sigiloso (POL-09)',
   'HIGH', true, false, 'MVP1'),
  ('PROCESS_SET_CONFIDENTIAL_BUDGET', 'process', 'Definir sigilo do orçamento',
   'Marcar ou desmarcar o orçamento estimado do processo como sigiloso',
   'HIGH', true, false, 'MVP1'),
  ('PROCESS_EXPORT', 'process', 'Exportar lista de processos',
   'CSV (P2)',
   'MEDIUM', true, false, 'MVP1'),
  ('TAG_MANAGE', 'process', 'Gerenciar etiquetas',
   'Cadastro de etiquetas do tenant',
   'LOW', false, false, 'MVP1'),
  ('DOCUMENT_CREATE', 'document', 'Criar documento livre/externo',
   'Tipos FREE_TEXT e UPLOADED',
   'MEDIUM', true, false, 'MVP1'),
  ('DOCUMENT_UPDATE', 'document', 'Editar documento livre/externo',
   'Editar documentos livres e externos — exige custódia (POL-02)',
   'MEDIUM', true, false, 'MVP1'),
  ('DOCUMENT_SUBMIT', 'document', 'Finalizar/submeter documento livre/externo',
   'Finalizar ou submeter documentos livres e externos (POL-02)',
   'MEDIUM', true, false, 'MVP1'),
  ('DOCUMENT_REOPEN', 'document', 'Reabrir documento',
   'Reabrir documento concluído de qualquer tipo, com justificativa (POL-11)',
   'HIGH', true, false, 'MVP1'),
  ('DOCUMENT_CANCEL', 'document', 'Cancelar documento',
   'Qualquer tipo, com custódia',
   'MEDIUM', true, false, 'MVP1'),
  ('ATTACHMENT_UPLOAD', 'files', 'Anexar arquivos',
   'Inclui excluir os próprios anexos enquanto o alvo estiver editável',
   'MEDIUM', true, false, 'MVP1'),
  ('ATTACHMENT_DELETE', 'files', 'Excluir anexos de terceiros',
   'Exclusão lógica com motivo',
   'MEDIUM', true, false, 'MVP1'),
  ('SUPPLIER_VIEW', 'supplier', 'Visualizar fornecedores',
   'Consultar o cadastro de fornecedores do órgão',
   'LOW', false, false, 'MVP1'),
  ('SUPPLIER_MANAGE', 'supplier', 'Gerenciar fornecedores',
   'Cadastrar, editar e inativar fornecedores',
   'MEDIUM', false, false, 'MVP1'),
  ('TEMPLATE_VIEW', 'document', 'Visualizar templates',
   'Consultar os templates de documento e suas versões',
   'LOW', false, false, 'MVP1'),
  ('TEMPLATE_MANAGE', 'document', 'Editar templates',
   'Rascunhos de versão',
   'MEDIUM', false, false, 'MVP1'),
  ('TEMPLATE_PUBLISH', 'document', 'Publicar templates',
   'Publicar versões de templates de documento',
   'HIGH', false, false, 'MVP1'),
  ('DOCUMENT_TYPE_MANAGE', 'document', 'Gerenciar tipos de documento',
   'Criar, editar, ativar e desativar tipos de documento do órgão',
   'HIGH', false, false, 'MVP1'),
  ('DFD_CREATE', 'dfd', 'Criar DFD',
   'Inclui duplicar DFD',
   'MEDIUM', true, false, 'MVP1'),
  ('DFD_UPDATE', 'dfd', 'Editar DFD',
   'Editar o DFD — exige custódia (POL-02)',
   'MEDIUM', true, false, 'MVP1'),
  ('DFD_SUBMIT', 'dfd', 'Concluir/submeter DFD',
   'Finalizar (ou submeter, se o tipo exigir aprovação avulsa)',
   'MEDIUM', true, false, 'MVP1'),
  ('ETP_CREATE', 'etp', 'Criar ETP',
   'Criar o Estudo Técnico Preliminar (ETP) do processo',
   'MEDIUM', true, false, 'MVP1'),
  ('ETP_UPDATE', 'etp', 'Editar ETP',
   'Inclui alternativas e estimativas',
   'MEDIUM', true, false, 'MVP1'),
  ('ETP_SUBMIT', 'etp', 'Concluir/submeter ETP',
   'Concluir ou submeter o ETP à aprovação',
   'MEDIUM', true, false, 'MVP1'),
  ('PRICE_RESEARCH_CREATE', 'price-research', 'Criar pesquisa de preços',
   'Criar a pesquisa de preços do processo',
   'MEDIUM', true, false, 'MVP1'),
  ('PRICE_RESEARCH_UPDATE', 'price-research', 'Editar pesquisa de preços',
   'Fontes, cotações, itens, método',
   'MEDIUM', true, false, 'MVP1'),
  ('PRICE_RESEARCH_EXCLUDE_QUOTATION', 'price-research', 'Desconsiderar/restaurar cotação',
   'Exige justificativa',
   'MEDIUM', true, false, 'MVP1'),
  ('PRICE_RESEARCH_COMPLETE', 'price-research', 'Concluir pesquisa de preços',
   'Concluir a pesquisa de preços',
   'MEDIUM', true, false, 'MVP1'),
  ('RISK_MANAGE', 'risk', 'Gerenciar riscos',
   'Riscos e tratamentos',
   'MEDIUM', true, false, 'MVP1'),
  ('RISK_MAP_SUBMIT', 'risk', 'Concluir/submeter mapa de riscos',
   'Concluir ou submeter o mapa de riscos à aprovação',
   'MEDIUM', true, false, 'MVP1'),
  ('TERM_CREATE', 'term', 'Criar TR',
   'Criar o Termo de Referência (TR) do processo',
   'MEDIUM', true, false, 'MVP1'),
  ('TERM_UPDATE', 'term', 'Editar TR',
   'Inclui importação do ETP',
   'MEDIUM', true, false, 'MVP1'),
  ('TERM_SUBMIT', 'term', 'Concluir/submeter TR',
   'Concluir ou submeter o TR à aprovação',
   'MEDIUM', true, false, 'MVP1'),
  ('WORKFLOW_VIEW', 'workflow', 'Visualizar workflows',
   'Consultar as definições de workflow e suas versões',
   'LOW', false, false, 'MVP1'),
  ('WORKFLOW_MANAGE', 'workflow', 'Editar workflows',
   'Rascunhos; regras',
   'HIGH', false, false, 'MVP1'),
  ('WORKFLOW_PUBLISH', 'workflow', 'Publicar/aposentar workflows',
   'Publicar e aposentar versões de workflow',
   'HIGH', false, false, 'MVP1'),
  ('APPROVAL_VIEW', 'approval', 'Visualizar aprovações',
   'Lista de aprovações dos processos no escopo',
   'LOW', true, false, 'MVP1'),
  ('APPROVAL_DECIDE', 'approval', 'Decidir aprovações',
   'Aprovar ou rejeitar pendências, somente quando designado (POL-03)',
   'HIGH', true, false, 'MVP1'),
  ('APPROVAL_REASSIGN', 'approval', 'Redirecionar aprovação',
   'Trocar aprovador de pendência (ausência, impedimento)',
   'MEDIUM', true, false, 'MVP1'),
  ('COMMENT_CREATE', 'collaboration', 'Comentar',
   'Em processos visíveis',
   'LOW', true, false, 'MVP1'),
  ('COMMENT_MODERATE', 'collaboration', 'Moderar comentários',
   'Excluir comentários de terceiros com motivo',
   'MEDIUM', true, false, 'MVP1'),
  ('INBOX_VIEW', 'inbox', 'Acessar caixa de tarefas',
   'Acessar a caixa de tarefas pessoal e das unidades',
   'LOW', false, false, 'MVP1'),
  ('DASHBOARD_VIEW', 'dashboard', 'Acessar dashboard',
   'Dados restritos à visibilidade de processos',
   'LOW', true, false, 'MVP1'),
  ('AUDIT_VIEW', 'audit', 'Consultar auditoria',
   'Consultar a trilha de auditoria do órgão',
   'HIGH', false, false, 'MVP1'),
  ('AUDIT_EXPORT', 'audit', 'Exportar auditoria',
   'Exportar registros da trilha de auditoria',
   'HIGH', false, false, 'MVP1'),
  ('USER_VIEW', 'identity', 'Visualizar usuários',
   'Tela de administração de usuários',
   'LOW', false, false, 'MVP1'),
  ('USER_INVITE', 'identity', 'Convidar usuários',
   'Convidar novos usuários para o órgão',
   'HIGH', false, false, 'MVP1'),
  ('USER_MANAGE', 'identity', 'Gerenciar usuários',
   'Editar, lotar, suspender, reativar, revogar',
   'HIGH', false, false, 'MVP1'),
  ('ROLE_VIEW', 'access', 'Visualizar perfis',
   'Consultar os perfis, a matriz de permissões e as atribuições',
   'LOW', false, false, 'MVP1'),
  ('ROLE_MANAGE', 'access', 'Gerenciar perfis',
   'Criar/editar perfis e matriz de permissões',
   'HIGH', false, false, 'MVP1'),
  ('ROLE_ASSIGN', 'access', 'Atribuir perfis',
   'Atribuir e revogar perfis de usuários (POL-13)',
   'HIGH', false, false, 'MVP1'),
  ('ORGANIZATION_MANAGE', 'tenancy', 'Gerenciar órgãos/entidades',
   'Cadastrar e editar órgãos e entidades do tenant',
   'HIGH', false, false, 'MVP1'),
  ('DEPARTMENT_MANAGE', 'organization', 'Gerenciar secretarias e setores',
   'Cadastrar, mover e desativar secretarias e setores',
   'MEDIUM', false, false, 'MVP1'),
  ('CATALOG_MANAGE', 'catalog', 'Gerenciar catálogos',
   'Gerenciar os itens dos catálogos auxiliares do órgão',
   'MEDIUM', false, false, 'MVP1'),
  ('CALENDAR_MANAGE', 'catalog', 'Gerenciar calendário',
   'Gerenciar feriados e o calendário de dias úteis',
   'MEDIUM', false, false, 'MVP1'),
  ('SETTINGS_MANAGE', 'tenancy', 'Gerenciar configurações gerais',
   'Alterar as configurações gerais do órgão',
   'HIGH', false, false, 'MVP1')
ON CONFLICT ("code") DO UPDATE SET
  "module" = EXCLUDED."module",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "risk_level" = EXCLUDED."risk_level",
  "scopable" = EXCLUDED."scopable",
  "is_deprecated" = EXCLUDED."is_deprecated",
  "introduced_in" = EXCLUDED."introduced_in",
  "updated_at" = CURRENT_TIMESTAMP
WHERE ("permissions"."module", "permissions"."name", "permissions"."description",
       "permissions"."risk_level", "permissions"."scopable", "permissions"."is_deprecated",
       "permissions"."introduced_in")
  IS DISTINCT FROM
      (EXCLUDED."module", EXCLUDED."name", EXCLUDED."description", EXCLUDED."risk_level",
       EXCLUDED."scopable", EXCLUDED."is_deprecated", EXCLUDED."introduced_in");

-- 4. Perfis do tenant.
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "allow_external_assignment" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
    -- entities.md: SCREAMING_SNAKE.
    CONSTRAINT "roles_key_format" CHECK ("key" ~ '^[A-Z][A-Z0-9_]{1,59}$'),
    CONSTRAINT "roles_name_not_blank" CHECK (btrim("name") <> ''),
    -- DEC-035: só perfil de sistema é protegido (ADMIN_ORGAO).
    CONSTRAINT "roles_protected_is_system" CHECK (NOT "is_protected" OR "is_system")
);

CREATE UNIQUE INDEX "roles_tenant_id_id_key" ON "roles"("tenant_id", "id");
CREATE UNIQUE INDEX "roles_tenant_id_key_key" ON "roles"("tenant_id", "key");
CREATE UNIQUE INDEX "roles_tenant_id_lower_name_key" ON "roles"("tenant_id", lower("name"));

-- `key`, `tenant_id` e `is_system` não mudam depois da criação (entities.md: `key` imutável): a
-- chave sustenta as concessões padrão e a resolução de perfis por código.
CREATE FUNCTION cf_roles_immutable_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."key" IS DISTINCT FROM OLD."key"
     OR NEW."is_system" IS DISTINCT FROM OLD."is_system" THEN
    RAISE EXCEPTION 'roles: tenant_id, key e is_system são imutáveis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'A chave do perfil não muda (US-094 · entities.md Role).';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION cf_roles_immutable_columns() FROM PUBLIC;

CREATE TRIGGER "roles_immutable_columns" BEFORE UPDATE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION cf_roles_immutable_columns();

-- 5. Matriz perfil × permissão.
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_code" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("tenant_id", "role_id", "permission_code")
);

CREATE UNIQUE INDEX "role_permissions_tenant_id_id_key" ON "role_permissions"("tenant_id", "id");
CREATE INDEX "role_permissions_permission_code_idx" ON "role_permissions"("permission_code");

-- FKs antes da RLS (prisma/README.md): composta para o perfil (DEC-081), simples para o catálogo.
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_role_id_fkey"
  FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- RN-IAM-73: código do catálogo em uso não pode ser removido.
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey"
  FOREIGN KEY ("permission_code") REFERENCES "permissions"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. RLS (DEC-082 · RN-TEN-25).
SELECT cf_apply_tenant_rls('roles');
SELECT cf_apply_tenant_rls('role_permissions');

-- 7. Privilégios mínimos. Catálogo: só leitura para a aplicação. Perfis nunca são excluídos
-- (desativados — US-095); concessões saem da matriz pela gestão de perfis (DELETE só no cf_app).
-- O worker semeia no provisionamento (US-099).
GRANT SELECT ON "permissions" TO cf_app, cf_worker;
GRANT SELECT, INSERT, UPDATE ON "roles" TO cf_app, cf_worker;
GRANT SELECT, INSERT, DELETE ON "role_permissions" TO cf_app;
GRANT SELECT, INSERT ON "role_permissions" TO cf_worker;

RESET ROLE;
