/*
 * Manifesto da suíte "tenant leak" (US-100 · RN-TEN-36 · multi-tenancy.md §14): TODA operação da
 * API (OpenAPI, inclusive as internas) é classificada aqui — coberta pela suíte HTTP
 * (`test/tenant-leak/tenant-leak.spec.ts`) ou isenta com motivo. Rota nova sem classificação reprova
 * o build (`tenant-leak.spec.ts`). Ao criar uma rota com ID no caminho ou referência no corpo,
 * declare `pathParams`/`body` para que a suíte troque os IDs pelos do tenant B.
 */

/** Tipos de fixture do tenant B que a suíte sabe fornecer (cresce com as stories de negócio). */
export type LeakFixtureKind = 'membership' | 'department' | 'tenant';

/** IDs do tenant B por tipo de fixture (a suíte resolve). */
export type LeakIds = (kind: LeakFixtureKind) => string;

export interface CoveredOperation {
  readonly kind: 'covered';
  /** Parâmetros de caminho → fixture de B: a operação deve responder 404 `<RESOURCE>_NOT_FOUND`. */
  readonly pathParams?: Readonly<Record<string, LeakFixtureKind>>;
  /**
   * Corpo válido com referências de B: a operação deve responder 422 `REFERENCE_NOT_FOUND` em
   * `referenceFields`.
   */
  readonly body?: (ids: LeakIds) => unknown;
  readonly referenceFields?: readonly string[];
  /** Quem chama (padrão: usuário só do tenant A). */
  readonly caller?: 'single-tenant' | 'multi-tenant';
}

export interface ExemptOperation {
  readonly kind: 'exempt';
  /** Por que a operação não entra na suíte HTTP (≥ 20 caracteres, revisado no PR). */
  readonly reason: string;
}

export type TenantLeakCase = CoveredOperation | ExemptOperation;

const PROCESS_PARTICIPANTS_ROUTE =
  'Participantes do processo (US-012): a suíte genérica não tem processo nem participante do tenant B. O isolamento (PRC-28/29/31/32 com id de processo de B → 404 PROCESS_NOT_FOUND, PRC-30 com participante de B → 404 PARTICIPANT_NOT_FOUND sem revogar nada, usuário ou unidade de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, RLS, FKs compostas e índices únicos de process_participants) é coberto em test/tenant-leak/process-participants.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-participants.routes.spec.ts.';

const TAG_ROUTE =
  'Etiquetas (US-007): a suíte genérica não tem etiqueta nem processo do tenant B. O isolamento (TAG-01 sem etiquetas de B, TAG-03 com etiqueta de B → 404 NOT_FOUND sem alterar nada, PRC-18 com etiqueta de B → 422 REFERENCE_NOT_FOUND em tagIds e com processo de B → 404 PROCESS_NOT_FOUND, RLS e índice único lower(name) por tenant de tags e process_tags) é coberto em test/tenant-leak/process-tags.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/tags.routes.spec.ts.';

const SAVED_VIEW_ROUTE =
  'Visões salvas e exportação CSV (US-003): a suíte genérica não tem visão nem processo do tenant B. O isolamento (PRC-35 sem visões de B na listagem, PRC-37/38 com id de visão de B → 404 NOT_FOUND sem alterar nada, PRC-34 sem linhas de B no arquivo, RLS e índices únicos de saved_views) é coberto em test/tenant-leak/saved-views.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/saved-views.routes.spec.ts.';

const PROCESS_CONFIDENTIALITY_ROUTE =
  'Sigilo do orçamento estimado (US-013 · PRC-33): exige If-Match e a suíte genérica não tem processo nem documento do tenant B. O isolamento (PRC-33 com id de processo de B → 404 PROCESS_NOT_FOUND sem alterar nada, a pesquisa de preços de B intocada, RLS de processes e documents na cascata) é coberto em test/tenant-leak/process-confidentiality.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-confidentiality.routes.spec.ts.';

const USER_LOOKUP_ROUTE =
  'Busca de usuários para seleção (USR-02 · US-012): sem id no caminho nem referência no corpo; a lista vem dos vínculos do tenant ativo (RLS de tenant_memberships) — usuário só de outro tenant nunca aparece, coberto em src/modules/process/presentation/process-participants.routes.spec.ts.';

const AI_GENERATION_ROUTE =
  'Geração com IA (US-115): a suíte genérica não tem processo, documento nem geração do tenant B. O isolamento (AI-01 no processo de B → 404 PROCESS_NOT_FOUND; AI-02/AI-04 com geração de B → 404 AI_GENERATION_NOT_FOUND sem alterar nada; AI-03 do processo de B → 404; RLS de ai_generations com app.tenant_id diferente retornando vazio; FKs compostas por tenant; job com tenant incorreto) é coberto em test/tenant-leak/ai-generations.spec.ts (PostgreSQL real) e src/modules/ai/presentation/ai-generation.routes.spec.ts.';

const AI_USAGE_ROUTE =
  'IA no órgão (US-116): a suíte genérica não tem gerações nem processo do tenant B. O isolamento (AI-06 contando só as gerações do próprio tenant; AI-05 com processo de B → 404 NOT_FOUND; aviso de limite só a quem administra o próprio tenant; RLS de ai_generations nas somas) é coberto em test/tenant-leak/ai-usage.spec.ts (PostgreSQL real) e src/modules/ai/presentation/ai-usage.routes.spec.ts.';

const WORKFLOW_RULE_SCHEMA_ROUTE =
  'Schema do RuleContext (US-044 · WF-19): sem ID no caminho nem corpo; os documentos listados vêm só dos tipos ativos do tenant do contexto (RLS de document_types), coberto em src/modules/workflow/presentation/workflow-rules.routes.spec.ts.';

const WORKFLOW_RULE_TEST_ROUTE =
  'Testar regra (US-044 · WF-23): exige WORKFLOW_MANAGE (que o usuário comum da suíte não tem) e a suíte genérica não tem fixture de workflow nem de processo do tenant B; o isolamento (versão e processo de B → 404 igual ao inexistente, nada gravado) é coberto em test/tenant-leak/workflow-rules.spec.ts, com administradores nos dois tenants.';

const WORKFLOW_PUBLISHING_ROUTE =
  'Validar, publicar e aposentar versão (US-045 · WF-20/21/22): publicar e aposentar exigem WORKFLOW_PUBLISH e If-Match, e a suíte genérica não tem fixture de workflow do tenant B; o isolamento (versão de B → 404 igual ao inexistente, nada alterado) é coberto em test/tenant-leak/workflow-publishing.spec.ts, com administradores nos dois tenants.';

const EXAMPLE_ROUTE =
  'Rota interna de exemplo do pipeline (US-080/US-084): não lê nem grava dados de tenant e fica fora do contrato público.';

const DOCUMENT_TYPE_ADMIN_ROUTE =
  'Exige DOCUMENT_TYPE_MANAGE (que o usuário comum da suíte não tem): isolamento coberto em test/tenant-leak/document-types.spec.ts, com administradores nos dois tenants.';

const SUPPLIER_ROUTE =
  'Fornecedores (US-025): a suíte genérica não tem fixture de fornecedor do tenant B; o isolamento (404 em SUP-03/04/05, lookup SUP-06 e lista sem vazamento de B, mesmo CNPJ nos dois tenants e RLS de suppliers) é coberto em test/tenant-leak/suppliers.spec.ts, com usuários nos dois tenants, e em src/modules/supplier/presentation/supplier.routes.spec.ts.';

const ATTACHMENT_ROUTE =
  'Anexos (US-068): a suíte genérica não tem fixture de documento/anexo do tenant B; o isolamento (alvo de outro tenant → 404 sem anexo criado, ATT-03/04 de outro tenant → 404) é coberto em src/modules/files/presentation/attachment.routes.spec.ts, e a RLS de attachments, a guarda de chave de storage no banco e a trava condicional em test/tenant-leak/attachments.spec.ts.';

const ATTACHMENT_ACCESS_ROUTE =
  'Visualizar e baixar anexos (US-069): a suíte genérica não tem processo, documento nem anexo do tenant B. O isolamento (ATT-01 com processo de outro tenant e ATT-04/05 com anexo de outro tenant → 404 NOT_FOUND sem revelar nada e sem auditoria de download; RLS de attachments na listagem) é coberto em test/tenant-leak/attachment-download.spec.ts, com PostgreSQL real, e em src/modules/files/presentation/attachment-download.routes.spec.ts, que traz também a herança de POL-09 (alvo RESTRICTED → 403).';

const ORGANIZATION_ROUTE =
  'Órgãos (US-101): a suíte genérica ainda não tem fixture de órgão do tenant B; o isolamento (404 em ORG-03/04 e lista sem vazamento de B) é coberto em test/tenant-leak/organizations.spec.ts, com administradores nos dois tenants.';

const SETTINGS_ROUTE =
  'Configurações do tenant (US-103): o registro é por chave e o tenant vem só do contexto (não há ID no caminho nem referência no corpo); o isolamento (leitura e escrita sem atravessar tenants, RLS de tenant_settings) é coberto em test/tenant-leak/tenant-settings.spec.ts, com administradores nos dois tenants.';

const NUMBERING_ROUTE =
  'Prévia de numeração (US-105): exige SETTINGS_MANAGE (que o usuário comum da suíte não tem) e não há ID no caminho nem referência no corpo; o isolamento (prévia e numeração só com a sequência do tenant do contexto, RLS de number_sequences) é coberto em test/tenant-leak/numbering.spec.ts, com administradores nos dois tenants.';

const CATALOG_ROUTE =
  'Catálogos (US-104): a suíte genérica ainda não tem fixture de item de catálogo do tenant B; o isolamento (404 em CAT-03..05, 422 REFERENCE_NOT_FOUND em parentId/orderedIds de B, lista sem vazamento e RLS de catalog_items) é coberto em test/tenant-leak/catalog.spec.ts, com administradores nos dois tenants.';

const CALENDAR_ROUTE =
  'Calendário (US-106): a suíte genérica ainda não tem fixture de feriado do tenant B; o isolamento (404 em CAL-03/04, lista e cálculo de dias úteis sem os feriados de B e RLS de holidays) é coberto em test/tenant-leak/calendar.spec.ts, com administradores nos dois tenants.';

const ROLE_ROUTE =
  'Perfis (US-095): exige ROLE_VIEW/ROLE_MANAGE (que o usuário comum da suíte não tem) e a suíte genérica ainda não tem fixture de perfil do tenant B; o isolamento (404 ROLE_NOT_FOUND em ROL-04..08 com ids de B, lista sem perfis de B e RLS de roles/role_permissions) é coberto em test/tenant-leak/role-management.spec.ts, com administradores nos dois tenants.';

const ROLE_ASSIGNMENT_ROUTE =
  'Atribuição de perfis (US-096): exige ROLE_VIEW/USER_VIEW/ROLE_ASSIGN (que o usuário comum da suíte não tem) e a suíte genérica ainda não tem fixture de perfil nem de atribuição do tenant B; o isolamento (404 USER_NOT_FOUND/ROLE_NOT_FOUND/ROLE_ASSIGNMENT_NOT_FOUND com ids de B sem tocar nas atribuições de B, REFERENCE_NOT_FOUND em roleId/scopeOrganizationId/scopeDepartmentId de B e RLS de role_assignments) é coberto em test/tenant-leak/role-assignments.spec.ts, com administradores nos dois tenants.';

const DEPARTMENT_ROUTE =
  'Secretarias e setores (US-102): a fixture genérica de unidade do tenant B não é um registro de departments; o isolamento (404 em DEP-04..09, lista/lookup sem vazamento de B e REFERENCE_NOT_FOUND em parentId/organizationId/headUserId de B) é coberto em test/tenant-leak/departments.spec.ts, com administradores nos dois tenants.';

const USER_ADMIN_ROUTE =
  'Usuários e convites (US-091): exige USER_VIEW/USER_INVITE (que o usuário comum da suíte não tem); o isolamento (404 USER_NOT_FOUND em USR-04/05 com usuário só do tenant B, lista sem vínculos de B, REFERENCE_NOT_FOUND em departmentIds/roleId de B e RLS de tenant_memberships/membership_departments/role_assignments) é coberto em test/tenant-leak/invitations.spec.ts, com administradores nos dois tenants.';

const USER_MEMBERSHIP_ROUTE =
  'Gestão de vínculos (US-092): exige USER_VIEW/USER_MANAGE (que o usuário comum da suíte não tem); o isolamento (404 USER_NOT_FOUND em USR-07..13 com usuário só do tenant B sem alterar o vínculo dele, REFERENCE_NOT_FOUND em departmentIds de B, filtro por lotação sem vínculos de B e RLS de tenant_memberships/membership_departments) é coberto em test/tenant-leak/memberships.spec.ts, com administradores nos dois tenants.';

const INVITATION_TOKEN_ROUTE =
  'Aceite/consulta de convite (US-091): sem tenant ativo (CROSS_TENANT_LOOKUP) e sem ID no caminho — o convite vem do token, pelo cf_find_invitation; convite de outra pessoa → 404 INVITATION_INVALID e ativação só no tenant do convite, cobertos em test/tenant-leak/invitations.spec.ts.';

const PLATFORM_ROUTE =
  'Rota de plataforma (US-099): sem X-Tenant-Id e só para operador da plataforma com MFA, que não tem vínculo com tenants (DEC-139); isolamento dos seeders e operador sem vínculo cobertos em test/tenant-leak/tenant-provisioning.spec.ts.';

const WORKFLOW_ROUTE =
  'Workflows (US-040): exige WORKFLOW_VIEW/WORKFLOW_MANAGE e a suíte genérica ainda não tem fixture de workflow do tenant B; o isolamento (404 em WF-03/04/07..18 com ids de B, 422 REFERENCE_NOT_FOUND em toStageId/copyFromVersionId de B e RLS das 5 tabelas) é coberto em test/tenant-leak/workflows.spec.ts, com administradores nos dois tenants.';

const DEFAULT_WORKFLOW_ROUTE =
  'Workflow padrão e aplicabilidade (US-042): a suíte genérica não tem fixture de workflow nem de catálogo do tenant B; o isolamento (WF-01 só com linhas de A, 404 em WF-05 com id de B, WF-06 nunca resolve workflow de B e recusa item de catálogo de B com 422) é coberto em test/tenant-leak/default-workflows.spec.ts, com os seeders reais nos dois tenants.';

const TEMPLATE_ROUTE =
  'Templates (US-107/US-108): exige TEMPLATE_VIEW/TEMPLATE_MANAGE/TEMPLATE_PUBLISH e a suíte genérica ainda não tem fixture de template do tenant B; o isolamento (404 em TPL-03/04/05/06/07/08/10/11 e DTY-04 com ids de B, lista sem templates de B, 422 REFERENCE_NOT_FOUND em documentTypeId de B e RLS de document_templates/document_template_versions) é coberto em test/tenant-leak/templates.spec.ts, com administradores nos dois tenants.';

const TEMPLATE_PREVIEW_ROUTE =
  'Prévia efêmera do template (US-109): sem fixture de template do tenant B na suíte genérica; o isolamento (404 em TPL-09/12 com versão/prévia de B — estado no Redis com o tenant do contexto na chave) está em src/modules/document/presentation/template-layout.routes.spec.ts, e o logo de outro tenant em TPL-08 (422 REFERENCE_NOT_FOUND sobre a RLS de attachments) em test/tenant-leak/template-layout.spec.ts.';

const PROCESS_ACTIONS_ROUTE =
  'Ações e checklist do processo (US-041): a tabela processes nasce com a US-001, então a suíte genérica ainda não tem fixture de processo do tenant B. O isolamento (processo de outro tenant → 404 NOT_FOUND sem revelar nada, mesmo corpo do inexistente, e RLS de workflow_versions/workflow_rules impedindo ler a definição de B) é coberto em test/tenant-leak/process-actions.spec.ts.';

const PROCESS_PANEL_ROUTE =
  'Painel situacional do processo (US-004): a suíte genérica não tem processo do tenant B. O isolamento (PRC-04/PRC-07/PRC-10 com id de processo de B → 404 PROCESS_NOT_FOUND com o corpo do inexistente, sem access.denied, e a leitura REPEATABLE READ READ ONLY sob a RLS do tenant sem gravar auditoria nem outbox) é coberto em test/tenant-leak/process-panel.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-panel.routes.spec.ts.';

const PROCESS_LIST_ROUTE =
  'Lista de processos (US-002): a suíte genérica não tem processos do tenant B. O isolamento (filtros com unidade/órgão/ids de B → 200 com data vazio sem revelar nada, RLS com app.tenant_id diferente retornando vazio e X-Tenant-Id sem vínculo → 403) é coberto em test/tenant-leak/process-list.spec.ts, com PostgreSQL real.';

const PROCESS_ROUTE =
  'Processos (US-001): a suíte genérica não tem fixtures de catálogo, workflow publicado nem processo do tenant B. O isolamento (unidade/catálogo de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, PRC-04 com id de B → 404 PROCESS_NOT_FOUND, PRC-03 nunca lista processo de B, RLS e FKs compostas das tabelas do processo) é coberto em test/tenant-leak/processes.spec.ts, com PostgreSQL real.';

const PROCESS_DUPLICATE_ROUTE =
  'Duplicar processo (US-011): a suíte genérica não tem catálogo, workflow publicado nem processo do tenant B. O isolamento (PRC-27 com origem de B → 404 PROCESS_NOT_FOUND sem criar processo, setor de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, nada de B copiado — itens, documentos, anexos —, RLS e FKs compostas das tabelas escritas) é coberto em test/tenant-leak/process-duplicate.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-duplicate.routes.spec.ts.';

const PROCESS_UPDATE_ROUTE =
  'Edição do processo (US-005): a suíte genérica não tem processo do tenant B. O isolamento (PATCH com id de processo de B → 404 PROCESS_NOT_FOUND sem alterar nada, unidade/catálogo de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, RLS de processes/process_access) é coberto em test/tenant-leak/process-update.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-update.routes.spec.ts.';

const PROCESS_FORWARD_ROUTE =
  'Encaminhamento do processo (US-047 · PRC-19): exige If-Match, Idempotency-Key e um processo do tenant numa etapa com transição, que a suíte genérica não tem. O isolamento (PRC-19 com id de processo de B → 404 PROCESS_NOT_FOUND sem alterar nada, unidade de B em toDepartmentId → 422 REFERENCE_NOT_FOUND sem revelar o registro, RLS de processes/process_stages/process_movements/process_access) é coberto em test/tenant-leak/process-forward.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-forward.routes.spec.ts. A aprovação aberta no destino APPROVAL (US-051 — titular/perfil só do tenant do processo, RLS de approvals) em test/tenant-leak/approval-request.spec.ts.';

const PROCESS_RETURN_ROUTE =
  'Devolução do processo (US-048 · PRC-20): exige If-Match, Idempotency-Key e um processo do tenant numa etapa com destino de devolução já percorrido, que a suíte genérica não tem. O isolamento (PRC-20 com id de processo de B → 404 PROCESS_NOT_FOUND sem alterar nada, targetStageId de etapa percorrida por processo de B → 422 TRANSITION_NOT_AVAILABLE sem revelar o registro, RLS de processes/process_stages/process_assignments/process_movements/process_access) é coberto em test/tenant-leak/process-return.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-return.routes.spec.ts.';

const PROCESS_CLAIM_ROUTE =
  'Assumir processo (US-049 · PRC-21): exige If-Match e um processo do tenant na fila de uma unidade, que a suíte genérica não tem. O isolamento (PRC-21 com id de processo de B → 404 PROCESS_NOT_FOUND sem alterar nada, lotado em outra unidade → 403 PERMISSION_DENIED com access.denied, RLS de processes/process_stages/process_assignments/process_movements/process_access e o índice único de responsabilidade ativa) é coberto em test/tenant-leak/process-claim.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-claim.routes.spec.ts.';

const PROCESS_SUSPENSION_ROUTE =
  'Suspender e retomar processo (US-008 · PRC-23/PRC-24): exigem If-Match, Idempotency-Key e um processo do tenant numa etapa ativa com prazo, que a suíte genérica não tem. O isolamento (id de processo de B → 404 PROCESS_NOT_FOUND sem alterar nada, sem PROCESS_SUSPEND → 403 PERMISSION_DENIED com access.denied, tenant suspenso → 403 TENANT_SUSPENDED, RLS de processes/process_stages/process_movements/approvals) é coberto em test/tenant-leak/process-suspension.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-suspension.routes.spec.ts.';

const PROCESS_ITEMS_ROUTE =
  'Itens do processo (US-006): a suíte genérica não tem processo nem item do tenant B. O isolamento (PRC-13/14/17 com id de processo de B → 404 PROCESS_NOT_FOUND, PRC-15/16 com id de item de B → 404 NOT_FOUND sem alterar nada, unidade de medida de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, RLS e FKs compostas de process_items) é coberto em test/tenant-leak/process-items.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-items.routes.spec.ts.';

const RISK_ROUTE =
  'Riscos do processo (US-033): a suíte genérica não tem processo nem risco do tenant B. O isolamento (RSK-01/02 com id de processo de B → 404 NOT_FOUND, RSK-03/04/05 com id de risco de B → 404 NOT_FOUND sem alterar nada, categoria RISK_CATEGORY de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, RLS e FKs compostas de risks/risk_treatments) é coberto em test/tenant-leak/risks.spec.ts, com PostgreSQL real, e em src/modules/risk/presentation/risk.routes.spec.ts.';

const COMMENT_ROUTE =
  'Comentários (US-071): a suíte genérica não tem processo nem comentário do tenant B. O isolamento (CMT-01/02 com id de processo de B → 404 PROCESS_NOT_FOUND, CMT-03/04 com id de comentário de B → 404 COMMENT_NOT_FOUND sem alterar nada, documentId/parentId de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, RLS e FKs compostas de comments) é coberto em test/tenant-leak/comments.spec.ts, com PostgreSQL real, e em src/modules/collaboration/presentation/comment.routes.spec.ts.';

const MENTION_ROUTE =
  'Menções (US-072): a suíte genérica não tem processo nem usuário/unidade do tenant B visível ao processo. O isolamento (CMT-05 com id de processo de B → 404 PROCESS_NOT_FOUND, candidato homônimo de B nunca devolvido, nó mention com usuário ou unidade de B descartado sem gerar Mention nem evento, RLS e FKs compostas de mentions) é coberto em test/tenant-leak/mentions.spec.ts, com PostgreSQL real, e em src/modules/collaboration/presentation/mention.routes.spec.ts.';

const RISK_MAP_ROUTE =
  'Matriz e Mapa de Riscos (US-035): a suíte genérica não tem processo nem risco do tenant B. O isolamento (RSK-09/RSK-10 com id de processo de B → 404 NOT_FOUND sem revelar riscos nem criar documento, RLS de documents/risks/risk_treatments na leitura da matriz e na emissão) é coberto em test/tenant-leak/risk-map.spec.ts, com PostgreSQL real, e em src/modules/risk/presentation/risk-map.routes.spec.ts.';

const RISK_AI_ROUTE =
  'Riscos propostos pela IA (US-119): a suíte genérica não tem processo, risco nem geração do tenant B. O isolamento (RSK-11 com geração de B num processo de A → 404 AI_GENERATION_NOT_FOUND sem criar nada; contexto enviado ao provedor sem riscos nem textos de B; RLS de risks/risk_treatments/ai_generations; aplicação em transação única com falha induzida e corrida entre duas aplicações) é coberto em test/tenant-leak/ai-risk-map-draft.spec.ts, com PostgreSQL real, e em src/modules/ai/presentation/risk-map-draft.routes.spec.ts.';

const RISK_TREATMENT_ROUTE =
  'Ações de tratamento (US-034): a suíte genérica não tem risco nem tratamento do tenant B. O isolamento (RSK-06 com id de risco de B → 404 NOT_FOUND, RSK-07/08 com id de tratamento de B → 404 NOT_FOUND sem alterar nada, responsável ou unidade de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, RLS e FKs compostas de risk_treatments) é coberto em test/tenant-leak/risk-treatments.spec.ts, com PostgreSQL real, e em src/modules/risk/presentation/risk-treatment.routes.spec.ts.';

const AUDIT_SEAL_ROUTE =
  'Selos de integridade (US-074): a suíte genérica não tem trilha nem selos do tenant B. O isolamento (AUD-04 listando só os selos do tenant, AUD-05 sobre intervalo que só tem selo de B → 404 NOT_FOUND e RLS de audit_seals com app.tenant_id diferente) é coberto em test/tenant-leak/audit-seals.spec.ts, e a selagem só com os registros do tenant do job em apps/worker/test/tenant-leak/audit-sealer.spec.ts, com PostgreSQL real.';

const AUDIT_LOG_ROUTE =
  'Consulta e exportação da trilha (US-075): a suíte genérica não tem trilha do tenant B. O isolamento (AUD-01 e AUD-03 devolvendo só registros do tenant mesmo com filtros que casariam os de B, AUD-02 com id de registro de B → 404 NOT_FOUND com o corpo do inexistente, e a RLS de audit_logs com app.tenant_id diferente) é coberto em test/tenant-leak/audit-logs.spec.ts, com PostgreSQL real, e em src/modules/audit/presentation/audit-logs.routes.spec.ts.';

const PROCESS_TIMELINE_ROUTE =
  'Timeline do processo (US-060): a suíte genérica não tem processo nem entradas de timeline do tenant B. O isolamento (PRC-12 com id de processo de B → 404 PROCESS_NOT_FOUND sem revelar nada, RLS de process_timeline_entries com app.tenant_id diferente retornando vazio e cursor forjado com posição de B sem efeito) é coberto em test/tenant-leak/process-timeline.spec.ts, com PostgreSQL real.';

const PROCESS_MOVEMENTS_ROUTE =
  'Histórico de tramitações (US-054): a suíte genérica não tem processo nem tramitações do tenant B. O isolamento (PRC-11 com id de processo de B → 404 PROCESS_NOT_FOUND sem revelar nada, RLS de process_movements com app.tenant_id diferente retornando vazio, cursor e filtros com ids de B sem efeito e nomes hidratados só do próprio tenant) é coberto em test/tenant-leak/process-movements.spec.ts, com PostgreSQL real, e em src/modules/process/presentation/process-movements.routes.spec.ts.';

const DOCUMENT_ROUTE =
  'Documentos (US-065): a suíte genérica não tem processo nem documento do tenant B. O isolamento (DOC-03/04/08/09/10/12/13/14 com id de documento de B → 404 NOT_FOUND sem alterar nada, RLS de documents/document_versions/approvals/approval_documents com app.tenant_id diferente retornando vazio e FKs compostas por tenant) é coberto em test/tenant-leak/documents.spec.ts e src/modules/document/presentation/document.routes.spec.ts, com PostgreSQL real no primeiro.';

const DOCUMENT_VERSION_ROUTE =
  'Versões de documento (US-066): a suíte genérica não tem documento nem versão do tenant B. O isolamento (DOC-15/16/18 com id de documento de B e DOC-17 com id de versão de B → 404 NOT_FOUND; DOC-18 com versão de B num documento de A → 422 REFERENCE_NOT_FOUND, sem revelar nada; RLS e gatilho só-INSERT de document_versions) é coberto em test/tenant-leak/document-versions.spec.ts, com PostgreSQL real, e em src/modules/document/presentation/document-versions.routes.spec.ts.';

const DOCUMENT_RENDITION_ROUTE =
  'PDFs de documento (US-067): a suíte genérica não tem documento, versão nem rendition do tenant B. O isolamento (DOC-20 com documento de B, DOC-21 com versão de B e DOC-22/23 com rendition de B → 404 NOT_FOUND sem revelar nada; RLS, índices únicos parciais e gatilho de document_renditions) é coberto em test/tenant-leak/document-renditions.spec.ts, com PostgreSQL real, e em src/modules/document/presentation/renditions.routes.spec.ts.';

const DOCUMENT_AI_REVIEW_ROUTE =
  'Revisão do conteúdo gerado por IA (US-122): a suíte genérica não tem documento do tenant B com seção pendente. O isolamento (DOC-27 com DFD de B → 404 NOT_FOUND sem revelar nada nem alterar a proveniência; RLS de documents com app.tenant_id diferente retornando vazio) é coberto em test/tenant-leak/document-ai-review.spec.ts, com PostgreSQL real, e em src/modules/document/presentation/document-ai-review.routes.spec.ts.';

const DOCUMENT_AI_APPLY_ROUTE =
  'Aplicação do conteúdo gerado por IA (US-117): a suíte genérica não tem documento nem geração do tenant B. O isolamento (DOC-26 com DFD de B → 404 NOT_FOUND; com geração de B num DFD de A → 404 AI_GENERATION_NOT_FOUND sem alterar nada; AI-01 com o DFD de B → 404 NOT_FOUND; RLS de documents e ai_generations; aplicação em transação única com falha induzida) é coberto em test/tenant-leak/ai-dfd-draft.spec.ts, com PostgreSQL real, e em src/modules/ai/presentation/dfd-draft.routes.spec.ts.';

const UPLOADED_DOCUMENT_ROUTE =
  'Documento externo (US-064): a suíte genérica não tem processo, documento nem anexo do tenant B. O isolamento (DOC-02 com processo de B, DOC-19 com documento de B e ATT-05 com anexo de B → 404 NOT_FOUND sem revelar nada; DOC-19 com attachmentId AVAILABLE de B num documento de A → 422 REFERENCE_NOT_FOUND em attachmentId, sem versão gravada; RLS de attachments e document_versions) é coberto em test/tenant-leak/uploaded-documents.spec.ts, com PostgreSQL real, e em src/modules/document/presentation/uploaded-documents.routes.spec.ts.';

const DOCUMENT_PANEL_ROUTE =
  'Painel de documentos (US-062): a suíte genérica não tem processo nem documento do tenant B. O isolamento (DOC-01 com processo de outro tenant → 404 PROCESS_NOT_FOUND igual ao inexistente, sem revelar nada; RLS de documents na consulta do painel; processo não visível → 404 com access.denied) é coberto em test/tenant-leak/process-documents.spec.ts, com PostgreSQL real, e em src/modules/document/presentation/process-documents.routes.spec.ts.';

const DFD_ROUTE =
  'DFD e itens de documento (US-014): a suíte genérica não tem processo, DFD nem item de processo do tenant B. O isolamento (DFD-03 com DFD de B → 404 DFD_NOT_FOUND; DFD-01/02 com processo de B e DOC-06/07 com documento de B → 404 NOT_FOUND sem alterar nada; DOC-07 com processItemId de outro processo/tenant → 422 REFERENCE_NOT_FOUND sem revelar; RLS, FKs compostas, checks e índice único de dfds/document_items) é coberto em test/tenant-leak/dfds.spec.ts, com PostgreSQL real, e em src/modules/dfd/presentation/dfd.routes.spec.ts.';

const ETP_SECTIONS_ROUTE =
  'Editar seções do ETP (US-020): a suíte genérica não tem processo, documento nem ETP do tenant B. O isolamento (ETP-03 com ETP de B → 404 NOT_FOUND sem revelar o registro; DOC-05 numa seção do ETP de B → 404 NOT_FOUND sem alterar seção, revisão nem auditoria de nenhum tenant; RLS da leitura de etps/documents e da atualização condicional) é coberto em test/tenant-leak/etp-sections.spec.ts, com PostgreSQL real, e em src/modules/etp/presentation/etp-sections.routes.spec.ts.';

const ETP_ALTERNATIVES_ROUTE =
  'Alternativas de solução do ETP (US-021): a suíte genérica não tem processo, ETP nem alternativa do tenant B. O isolamento (ETP-05/06 com ETP de B → 404 NOT_FOUND sem ler nem criar nada; ETP-07/08/09 com alternativa de B → 404 NOT_FOUND sem alterar nada; RLS e FKs compostas de etp_alternatives, índices únicos parciais e CHECK da justificativa) é coberto em test/tenant-leak/etp-alternatives.spec.ts, com PostgreSQL real, e em src/modules/etp/presentation/etp-alternative.routes.spec.ts.';

const DFD_DUPLICATE_ROUTE =
  'Duplicar DFD (US-018): a suíte genérica não tem processo, DFD nem item de processo do tenant B. O isolamento (DFD-05 com DFD de B → 404 DFD_NOT_FOUND sem criar nada; targetProcessId de B ou inexistente → 422 REFERENCE_NOT_FOUND em targetProcessId sem revelar o registro; nada de B lido nem alterado; itens, documento e DFD criados só no tenant da requisição, com RLS e FKs compostas; transação única, índice único do DFD ativo sob concorrência e idempotência) é coberto em test/tenant-leak/dfd-duplicate.spec.ts, com PostgreSQL real, e em src/modules/dfd/presentation/dfd-duplicate.routes.spec.ts.';

const DOCUMENT_AUTOSAVE_ROUTE =
  'Autosave do DFD (US-015): a suíte genérica não tem processo, documento nem DFD do tenant B. O isolamento (DOC-05 com documento de B → 404 NOT_FOUND e DFD-04 com DFD de B → 404 DFD_NOT_FOUND, sem alterar nenhuma seção, revisão, versão nem auditoria de nenhum tenant; a atualização condicional atômica com app.tenant_id e tenant_id explícito; 50 gravações concorrentes na mesma seção — exatamente uma por revisão) é coberto em test/tenant-leak/dfd-autosave.spec.ts, com PostgreSQL real, e em src/modules/dfd/presentation/dfd-autosave.routes.spec.ts.';

const PRICE_RESEARCH_ROUTE =
  'Pesquisa de preços (US-024): a suíte genérica não tem processo, pesquisa nem item de processo do tenant B. O isolamento (PRS-01/02 com processo de B e PRS-03/04/05/06 com pesquisa de B → 404 NOT_FOUND, PRS-08 com item de B → 404 NOT_FOUND, sem alterar nada nem revelar o código; processItemId de outro processo/tenant no corpo do PRS-02/06 → 422 REFERENCE_NOT_FOUND sem revelar; RLS, FKs compostas, checks, índice único e cascata de price_research/price_items) é coberto em test/tenant-leak/price-research.spec.ts, com PostgreSQL real, e em src/modules/price-research/presentation/price-research.routes.spec.ts.';

const PRICE_SOURCE_ROUTE =
  'Fontes e cotações (US-026): a suíte genérica não tem pesquisa, fonte, cotação nem fornecedor do tenant B. O isolamento (PRS-09/10 com pesquisa de B → 404 NOT_FOUND, PRS-11/12/13 com fonte de B e PRS-14/15 com cotação de B → 404 NOT_FOUND sem alterar nada; supplierId/sourceTypeId de B no corpo do PRS-10/11 → 422 REFERENCE_NOT_FOUND sem revelar; RLS, FKs compostas para catalog_items/suppliers, índice único (item, fonte), checks e cascatas de price_sources/quotations) é coberto em test/tenant-leak/price-sources.spec.ts, com PostgreSQL real, e em src/modules/price-research/presentation/price-sources.routes.spec.ts.';

const ETP_ROUTE =
  'ETP (US-019): a suíte genérica não tem processo, DFD nem ETP do tenant B. O isolamento (ETP-01/02 com processo de B → 404 NOT_FOUND sem criar nem ler nada; o DFD de origem só é lido no tenant do processo; RLS, FKs compostas — documento, processo, versão do DFD — e checks de etps) é coberto em test/tenant-leak/etps.spec.ts, com PostgreSQL real, e em src/modules/etp/presentation/etp.routes.spec.ts.';

/** Classificação por `operationId`. */
const NOTIFICATION_ROUTE =
  'Central de notificações (US-111): só as notificações do próprio destinatário, sem referência no corpo; a suíte genérica ainda não tem fixture de notificação do tenant B. O isolamento (404 NOTIFICATION_NOT_FOUND em NTF-03/05 com ids de outro tenant e de outro usuário, lista e contador sem vazamento e RLS de notifications) é coberto em test/tenant-leak/notifications.spec.ts.';

export const TENANT_LEAK_MANIFEST: Readonly<Record<string, TenantLeakCase>> = Object.freeze({
  'NTF-01': { kind: 'exempt', reason: NOTIFICATION_ROUTE },
  'NTF-02': { kind: 'exempt', reason: NOTIFICATION_ROUTE },
  'NTF-03': { kind: 'exempt', reason: NOTIFICATION_ROUTE },
  'NTF-04': { kind: 'exempt', reason: NOTIFICATION_ROUTE },
  'NTF-05': { kind: 'exempt', reason: NOTIFICATION_ROUTE },
  'ME-05': { kind: 'covered' },
  'ME-06': {
    kind: 'exempt',
    reason:
      'Preferências de notificação (US-113): sem ID no caminho nem referência de outro recurso no corpo — só tipo/canal do registro e o próprio usuário do token; o isolamento (preferência de A nunca vale em B, outro usuário nunca lida, RLS e GRANTs de notification_preferences) é coberto em test/tenant-leak/notification-preferences.spec.ts.',
  },
  'ME-01': { kind: 'covered' },
  'ME-04': { kind: 'covered' },
  'ME-02': {
    kind: 'exempt',
    reason:
      'Meu perfil (US-098): exige If-Match (a suíte genérica não envia) e não há ID no caminho nem referência no corpo — só o próprio User do token; o isolamento (X-Tenant-Id sem vínculo → 403, auditoria só no tenant do contexto e nenhuma escrita em outro usuário) é coberto em test/tenant-leak/my-profile.spec.ts.',
  },
  // US-097: permissões do próprio vínculo, sem ID no caminho; o isolamento com PostgreSQL e Redis
  // reais está em test/tenant-leak/authorization.spec.ts.
  'ME-03': { kind: 'covered' },
  'DTY-01': { kind: 'covered' },
  'DTY-02': {
    kind: 'exempt',
    reason: DOCUMENT_TYPE_ADMIN_ROUTE,
  },
  'DTY-03': {
    kind: 'exempt',
    reason: DOCUMENT_TYPE_ADMIN_ROUTE,
  },
  'DTY-04': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'DEP-01': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-02': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-03': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-04': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-05': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-06': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-07': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-08': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'DEP-09': { kind: 'exempt', reason: DEPARTMENT_ROUTE },
  'SUP-01': { kind: 'exempt', reason: SUPPLIER_ROUTE },
  'SUP-02': { kind: 'exempt', reason: SUPPLIER_ROUTE },
  'SUP-03': { kind: 'exempt', reason: SUPPLIER_ROUTE },
  'SUP-04': { kind: 'exempt', reason: SUPPLIER_ROUTE },
  'SUP-05': { kind: 'exempt', reason: SUPPLIER_ROUTE },
  'SUP-06': { kind: 'exempt', reason: SUPPLIER_ROUTE },
  'ATT-01': { kind: 'exempt', reason: ATTACHMENT_ACCESS_ROUTE },
  'ATT-02': { kind: 'exempt', reason: ATTACHMENT_ROUTE },
  'ATT-03': { kind: 'exempt', reason: ATTACHMENT_ROUTE },
  'ATT-04': { kind: 'exempt', reason: ATTACHMENT_ACCESS_ROUTE },
  'ATT-05': { kind: 'exempt', reason: ATTACHMENT_ACCESS_ROUTE },
  'ATT-06': { kind: 'exempt', reason: ATTACHMENT_ROUTE },
  'ORG-01': { kind: 'exempt', reason: ORGANIZATION_ROUTE },
  'ORG-02': { kind: 'exempt', reason: ORGANIZATION_ROUTE },
  'ORG-03': { kind: 'exempt', reason: ORGANIZATION_ROUTE },
  'ORG-04': { kind: 'exempt', reason: ORGANIZATION_ROUTE },
  'CAT-01': { kind: 'exempt', reason: CATALOG_ROUTE },
  'CAT-02': { kind: 'exempt', reason: CATALOG_ROUTE },
  'CAT-03': { kind: 'exempt', reason: CATALOG_ROUTE },
  'CAT-04': { kind: 'exempt', reason: CATALOG_ROUTE },
  'CAT-05': { kind: 'exempt', reason: CATALOG_ROUTE },
  'CAT-06': { kind: 'exempt', reason: CATALOG_ROUTE },
  'CAL-01': { kind: 'exempt', reason: CALENDAR_ROUTE },
  'CAL-02': { kind: 'exempt', reason: CALENDAR_ROUTE },
  'CAL-03': { kind: 'exempt', reason: CALENDAR_ROUTE },
  'CAL-04': { kind: 'exempt', reason: CALENDAR_ROUTE },
  'CAL-05': { kind: 'exempt', reason: CALENDAR_ROUTE },
  'CAL-06': { kind: 'exempt', reason: CALENDAR_ROUTE },
  'SET-01': { kind: 'exempt', reason: SETTINGS_ROUTE },
  'SET-02': { kind: 'exempt', reason: SETTINGS_ROUTE },
  'SET-03': { kind: 'exempt', reason: SETTINGS_ROUTE },
  'SET-04': { kind: 'exempt', reason: NUMBERING_ROUTE },
  'WF-01': { kind: 'exempt', reason: DEFAULT_WORKFLOW_ROUTE },
  'WF-02': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-05': { kind: 'exempt', reason: DEFAULT_WORKFLOW_ROUTE },
  'WF-06': { kind: 'exempt', reason: DEFAULT_WORKFLOW_ROUTE },
  'WF-03': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-04': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-07': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-08': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-09': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-10': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-11': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-12': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-13': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-14': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-15': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-16': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-17': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-18': { kind: 'exempt', reason: WORKFLOW_ROUTE },
  'WF-19': { kind: 'exempt', reason: WORKFLOW_RULE_SCHEMA_ROUTE },
  'WF-20': { kind: 'exempt', reason: WORKFLOW_PUBLISHING_ROUTE },
  'WF-21': { kind: 'exempt', reason: WORKFLOW_PUBLISHING_ROUTE },
  'WF-22': { kind: 'exempt', reason: WORKFLOW_PUBLISHING_ROUTE },
  'WF-23': { kind: 'exempt', reason: WORKFLOW_RULE_TEST_ROUTE },
  'PRC-01': { kind: 'exempt', reason: PROCESS_LIST_ROUTE },
  'PRC-02': { kind: 'exempt', reason: PROCESS_ROUTE },
  'PRC-03': { kind: 'exempt', reason: PROCESS_ROUTE },
  'PRC-04': { kind: 'exempt', reason: PROCESS_ROUTE },
  'PRC-05': { kind: 'exempt', reason: PROCESS_UPDATE_ROUTE },
  'PRC-07': { kind: 'exempt', reason: PROCESS_PANEL_ROUTE },
  'PRC-08': { kind: 'exempt', reason: PROCESS_ACTIONS_ROUTE },
  'PRC-09': { kind: 'exempt', reason: PROCESS_ACTIONS_ROUTE },
  'PRC-10': { kind: 'exempt', reason: PROCESS_PANEL_ROUTE },
  'PRC-11': { kind: 'exempt', reason: PROCESS_MOVEMENTS_ROUTE },
  'PRC-12': { kind: 'exempt', reason: PROCESS_TIMELINE_ROUTE },
  'PRC-13': { kind: 'exempt', reason: PROCESS_ITEMS_ROUTE },
  'PRC-14': { kind: 'exempt', reason: PROCESS_ITEMS_ROUTE },
  'PRC-15': { kind: 'exempt', reason: PROCESS_ITEMS_ROUTE },
  'PRC-16': { kind: 'exempt', reason: PROCESS_ITEMS_ROUTE },
  'PRC-17': { kind: 'exempt', reason: PROCESS_ITEMS_ROUTE },
  'PRC-19': { kind: 'exempt', reason: PROCESS_FORWARD_ROUTE },
  'PRC-20': { kind: 'exempt', reason: PROCESS_RETURN_ROUTE },
  'PRC-21': { kind: 'exempt', reason: PROCESS_CLAIM_ROUTE },
  'PRC-23': { kind: 'exempt', reason: PROCESS_SUSPENSION_ROUTE },
  'PRC-24': { kind: 'exempt', reason: PROCESS_SUSPENSION_ROUTE },
  'RSK-01': { kind: 'exempt', reason: RISK_ROUTE },
  'RSK-02': { kind: 'exempt', reason: RISK_ROUTE },
  'RSK-03': { kind: 'exempt', reason: RISK_ROUTE },
  'RSK-04': { kind: 'exempt', reason: RISK_ROUTE },
  'RSK-05': { kind: 'exempt', reason: RISK_ROUTE },
  'RSK-06': { kind: 'exempt', reason: RISK_TREATMENT_ROUTE },
  'RSK-07': { kind: 'exempt', reason: RISK_TREATMENT_ROUTE },
  'RSK-08': { kind: 'exempt', reason: RISK_TREATMENT_ROUTE },
  'RSK-09': { kind: 'exempt', reason: RISK_MAP_ROUTE },
  'RSK-10': { kind: 'exempt', reason: RISK_MAP_ROUTE },
  'RSK-11': { kind: 'exempt', reason: RISK_AI_ROUTE },
  'RSK-12': { kind: 'exempt', reason: RISK_AI_ROUTE },
  'CMT-01': { kind: 'exempt', reason: COMMENT_ROUTE },
  'CMT-02': { kind: 'exempt', reason: COMMENT_ROUTE },
  'CMT-03': { kind: 'exempt', reason: COMMENT_ROUTE },
  'CMT-04': { kind: 'exempt', reason: COMMENT_ROUTE },
  'CMT-05': { kind: 'exempt', reason: MENTION_ROUTE },
  'PRC-18': { kind: 'exempt', reason: TAG_ROUTE },
  'PRC-27': { kind: 'exempt', reason: PROCESS_DUPLICATE_ROUTE },
  'PRC-28': { kind: 'exempt', reason: PROCESS_PARTICIPANTS_ROUTE },
  'PRC-29': { kind: 'exempt', reason: PROCESS_PARTICIPANTS_ROUTE },
  'PRC-30': { kind: 'exempt', reason: PROCESS_PARTICIPANTS_ROUTE },
  'PRC-31': { kind: 'exempt', reason: PROCESS_PARTICIPANTS_ROUTE },
  'PRC-32': { kind: 'exempt', reason: PROCESS_PARTICIPANTS_ROUTE },
  'PRC-33': { kind: 'exempt', reason: PROCESS_CONFIDENTIALITY_ROUTE },
  'PRC-34': { kind: 'exempt', reason: SAVED_VIEW_ROUTE },
  'PRC-35': { kind: 'exempt', reason: SAVED_VIEW_ROUTE },
  'PRC-36': { kind: 'exempt', reason: SAVED_VIEW_ROUTE },
  'PRC-37': { kind: 'exempt', reason: SAVED_VIEW_ROUTE },
  'PRC-38': { kind: 'exempt', reason: SAVED_VIEW_ROUTE },
  'TAG-01': { kind: 'exempt', reason: TAG_ROUTE },
  'TAG-02': { kind: 'exempt', reason: TAG_ROUTE },
  'TAG-03': { kind: 'exempt', reason: TAG_ROUTE },
  'DOC-01': { kind: 'exempt', reason: DOCUMENT_PANEL_ROUTE },
  'DOC-02': { kind: 'exempt', reason: UPLOADED_DOCUMENT_ROUTE },
  'DOC-03': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-04': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-05': { kind: 'exempt', reason: DOCUMENT_AUTOSAVE_ROUTE },
  'DOC-06': { kind: 'exempt', reason: DFD_ROUTE },
  'DOC-07': { kind: 'exempt', reason: DFD_ROUTE },
  'DOC-08': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-09': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-10': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-12': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-13': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-14': { kind: 'exempt', reason: DOCUMENT_ROUTE },
  'DOC-15': { kind: 'exempt', reason: DOCUMENT_VERSION_ROUTE },
  'DOC-16': { kind: 'exempt', reason: DOCUMENT_VERSION_ROUTE },
  'DOC-17': { kind: 'exempt', reason: DOCUMENT_VERSION_ROUTE },
  'DOC-18': { kind: 'exempt', reason: DOCUMENT_VERSION_ROUTE },
  'DOC-19': { kind: 'exempt', reason: UPLOADED_DOCUMENT_ROUTE },
  'DOC-20': { kind: 'exempt', reason: DOCUMENT_RENDITION_ROUTE },
  'DOC-21': { kind: 'exempt', reason: DOCUMENT_RENDITION_ROUTE },
  'DOC-22': { kind: 'exempt', reason: DOCUMENT_RENDITION_ROUTE },
  'DOC-23': { kind: 'exempt', reason: DOCUMENT_RENDITION_ROUTE },
  'DOC-26': { kind: 'exempt', reason: DOCUMENT_AI_APPLY_ROUTE },
  'DOC-27': { kind: 'exempt', reason: DOCUMENT_AI_REVIEW_ROUTE },
  'DFD-01': { kind: 'exempt', reason: DFD_ROUTE },
  'DFD-02': { kind: 'exempt', reason: DFD_ROUTE },
  'DFD-03': { kind: 'exempt', reason: DFD_ROUTE },
  'DFD-04': { kind: 'exempt', reason: DOCUMENT_AUTOSAVE_ROUTE },
  'DFD-05': { kind: 'exempt', reason: DFD_DUPLICATE_ROUTE },
  'ETP-01': { kind: 'exempt', reason: ETP_ROUTE },
  'ETP-02': { kind: 'exempt', reason: ETP_ROUTE },
  'ETP-03': { kind: 'exempt', reason: ETP_SECTIONS_ROUTE },
  'ETP-05': { kind: 'exempt', reason: ETP_ALTERNATIVES_ROUTE },
  'ETP-06': { kind: 'exempt', reason: ETP_ALTERNATIVES_ROUTE },
  'ETP-07': { kind: 'exempt', reason: ETP_ALTERNATIVES_ROUTE },
  'ETP-08': { kind: 'exempt', reason: ETP_ALTERNATIVES_ROUTE },
  'ETP-09': { kind: 'exempt', reason: ETP_ALTERNATIVES_ROUTE },
  'PRS-01': { kind: 'exempt', reason: PRICE_RESEARCH_ROUTE },
  'PRS-02': { kind: 'exempt', reason: PRICE_RESEARCH_ROUTE },
  'PRS-03': { kind: 'exempt', reason: PRICE_RESEARCH_ROUTE },
  'PRS-04': { kind: 'exempt', reason: PRICE_RESEARCH_ROUTE },
  'PRS-05': { kind: 'exempt', reason: PRICE_RESEARCH_ROUTE },
  'PRS-06': { kind: 'exempt', reason: PRICE_RESEARCH_ROUTE },
  'PRS-08': { kind: 'exempt', reason: PRICE_RESEARCH_ROUTE },
  'PRS-09': { kind: 'exempt', reason: PRICE_SOURCE_ROUTE },
  'PRS-10': { kind: 'exempt', reason: PRICE_SOURCE_ROUTE },
  'PRS-11': { kind: 'exempt', reason: PRICE_SOURCE_ROUTE },
  'PRS-12': { kind: 'exempt', reason: PRICE_SOURCE_ROUTE },
  'PRS-13': { kind: 'exempt', reason: PRICE_SOURCE_ROUTE },
  'PRS-14': { kind: 'exempt', reason: PRICE_SOURCE_ROUTE },
  'PRS-15': { kind: 'exempt', reason: PRICE_SOURCE_ROUTE },
  'AI-01': { kind: 'exempt', reason: AI_GENERATION_ROUTE },
  'AI-02': { kind: 'exempt', reason: AI_GENERATION_ROUTE },
  'AI-03': { kind: 'exempt', reason: AI_GENERATION_ROUTE },
  'AI-04': { kind: 'exempt', reason: AI_GENERATION_ROUTE },
  'AI-05': { kind: 'exempt', reason: AI_USAGE_ROUTE },
  'AI-06': { kind: 'exempt', reason: AI_USAGE_ROUTE },
  'AUD-01': { kind: 'exempt', reason: AUDIT_LOG_ROUTE },
  'AUD-02': { kind: 'exempt', reason: AUDIT_LOG_ROUTE },
  'AUD-03': { kind: 'exempt', reason: AUDIT_LOG_ROUTE },
  'AUD-04': { kind: 'exempt', reason: AUDIT_SEAL_ROUTE },
  'AUD-05': { kind: 'exempt', reason: AUDIT_SEAL_ROUTE },
  'TPL-01': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-02': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-03': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-04': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-05': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-06': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-07': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-08': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-09': { kind: 'exempt', reason: TEMPLATE_PREVIEW_ROUTE },
  'TPL-10': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-11': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-12': { kind: 'exempt', reason: TEMPLATE_PREVIEW_ROUTE },
  'TPL-13': { kind: 'exempt', reason: TEMPLATE_PREVIEW_ROUTE },
  'ROL-01': {
    kind: 'exempt',
    reason:
      'Catálogo global e idêntico entre tenants (sem dado de tenant) que exige ROLE_VIEW: vínculo de outro tenant → 403 MEMBERSHIP_INACTIVE em access/presentation/permission.routes.spec.ts; RLS de roles/role_permissions em test/tenant-leak/roles.spec.ts.',
  },
  'ROL-02': { kind: 'exempt', reason: ROLE_ROUTE },
  'ROL-03': { kind: 'exempt', reason: ROLE_ROUTE },
  'ROL-04': { kind: 'exempt', reason: ROLE_ROUTE },
  'ROL-05': { kind: 'exempt', reason: ROLE_ROUTE },
  'ROL-06': { kind: 'exempt', reason: ROLE_ROUTE },
  'ROL-07': { kind: 'exempt', reason: ROLE_ROUTE },
  'ROL-08': { kind: 'exempt', reason: ROLE_ROUTE },
  'ROL-09': { kind: 'exempt', reason: ROLE_ASSIGNMENT_ROUTE },
  'ROL-10': { kind: 'exempt', reason: ROLE_ASSIGNMENT_ROUTE },
  'ROL-11': { kind: 'exempt', reason: ROLE_ASSIGNMENT_ROUTE },
  'ROL-12': { kind: 'exempt', reason: ROLE_ASSIGNMENT_ROUTE },
  'USR-01': { kind: 'exempt', reason: USER_ADMIN_ROUTE },
  'USR-02': { kind: 'exempt', reason: USER_LOOKUP_ROUTE },
  'USR-03': { kind: 'exempt', reason: USER_ADMIN_ROUTE },
  'USR-04': { kind: 'exempt', reason: USER_ADMIN_ROUTE },
  'USR-05': { kind: 'exempt', reason: USER_ADMIN_ROUTE },
  'USR-06': { kind: 'exempt', reason: INVITATION_TOKEN_ROUTE },
  'USR-07': { kind: 'exempt', reason: USER_MEMBERSHIP_ROUTE },
  'USR-08': { kind: 'exempt', reason: USER_MEMBERSHIP_ROUTE },
  'USR-09': { kind: 'exempt', reason: USER_MEMBERSHIP_ROUTE },
  'USR-10': { kind: 'exempt', reason: USER_MEMBERSHIP_ROUTE },
  'USR-11': { kind: 'exempt', reason: USER_MEMBERSHIP_ROUTE },
  'USR-12': { kind: 'exempt', reason: USER_MEMBERSHIP_ROUTE },
  'USR-13': { kind: 'exempt', reason: USER_MEMBERSHIP_ROUTE },
  'USR-14': { kind: 'exempt', reason: INVITATION_TOKEN_ROUTE },
  'INTERNAL-SESSION-EVENTS': {
    kind: 'exempt',
    reason:
      'Contrato BFF → API com credencial de serviço, fora de /api/v1; vínculo de outra pessoa → 422 REFERENCE_NOT_FOUND coberto em identity/presentation/tenant-switch.routes.spec.ts.',
  },
  'PLT-01': { kind: 'exempt', reason: PLATFORM_ROUTE },
  'PLT-02': { kind: 'exempt', reason: PLATFORM_ROUTE },
  'PLT-03': { kind: 'exempt', reason: PLATFORM_ROUTE },
  'PLT-04': { kind: 'exempt', reason: PLATFORM_ROUTE },
  'PLT-05': { kind: 'exempt', reason: PLATFORM_ROUTE },
  'INTERNAL-PING': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-ITEMS': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-FEED': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-ECHO': { kind: 'exempt', reason: EXAMPLE_ROUTE },
  'INTERNAL-TRACE-DEMO-JOB': { kind: 'exempt', reason: EXAMPLE_ROUTE },
});
