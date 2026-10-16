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

const EXAMPLE_ROUTE =
  'Rota interna de exemplo do pipeline (US-080/US-084): não lê nem grava dados de tenant e fica fora do contrato público.';

const DOCUMENT_TYPE_ADMIN_ROUTE =
  'Exige DOCUMENT_TYPE_MANAGE (que o usuário comum da suíte não tem): isolamento coberto em test/tenant-leak/document-types.spec.ts, com administradores nos dois tenants.';

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
  'Gestão de vínculos (US-092): exige USER_VIEW/USER_MANAGE (que o usuário comum da suíte não tem); o isolamento (404 USER_NOT_FOUND em USR-07..12 com usuário só do tenant B sem alterar o vínculo dele, REFERENCE_NOT_FOUND em departmentIds de B, filtro por lotação sem vínculos de B e RLS de tenant_memberships/membership_departments) é coberto em test/tenant-leak/memberships.spec.ts, com administradores nos dois tenants.';

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

const PROCESS_ACTIONS_ROUTE =
  'Ações e checklist do processo (US-041): a tabela processes nasce com a US-001, então a suíte genérica ainda não tem fixture de processo do tenant B. O isolamento (processo de outro tenant → 404 NOT_FOUND sem revelar nada, mesmo corpo do inexistente, e RLS de workflow_versions/workflow_rules impedindo ler a definição de B) é coberto em test/tenant-leak/process-actions.spec.ts.';

const PROCESS_LIST_ROUTE =
  'Lista de processos (US-002): a suíte genérica não tem processos do tenant B. O isolamento (filtros com unidade/órgão/ids de B → 200 com data vazio sem revelar nada, RLS com app.tenant_id diferente retornando vazio e X-Tenant-Id sem vínculo → 403) é coberto em test/tenant-leak/process-list.spec.ts, com PostgreSQL real.';

const PROCESS_ROUTE =
  'Processos (US-001): a suíte genérica não tem fixtures de catálogo, workflow publicado nem processo do tenant B. O isolamento (unidade/catálogo de B no corpo → 422 REFERENCE_NOT_FOUND sem revelar o registro, PRC-04 com id de B → 404 PROCESS_NOT_FOUND, PRC-03 nunca lista processo de B, RLS e FKs compostas das tabelas do processo) é coberto em test/tenant-leak/processes.spec.ts, com PostgreSQL real.';

const AUDIT_SEAL_ROUTE =
  'Selos de integridade (US-074): a suíte genérica não tem trilha nem selos do tenant B. O isolamento (AUD-04 listando só os selos do tenant, AUD-05 sobre intervalo que só tem selo de B → 404 NOT_FOUND e RLS de audit_seals com app.tenant_id diferente) é coberto em test/tenant-leak/audit-seals.spec.ts, e a selagem só com os registros do tenant do job em apps/worker/test/tenant-leak/audit-sealer.spec.ts, com PostgreSQL real.';

const PROCESS_TIMELINE_ROUTE =
  'Timeline do processo (US-060): a suíte genérica não tem processo nem entradas de timeline do tenant B. O isolamento (PRC-12 com id de processo de B → 404 PROCESS_NOT_FOUND sem revelar nada, RLS de process_timeline_entries com app.tenant_id diferente retornando vazio e cursor forjado com posição de B sem efeito) é coberto em test/tenant-leak/process-timeline.spec.ts, com PostgreSQL real.';

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
  'PRC-01': { kind: 'exempt', reason: PROCESS_LIST_ROUTE },
  'PRC-02': { kind: 'exempt', reason: PROCESS_ROUTE },
  'PRC-03': { kind: 'exempt', reason: PROCESS_ROUTE },
  'PRC-04': { kind: 'exempt', reason: PROCESS_ROUTE },
  'PRC-08': { kind: 'exempt', reason: PROCESS_ACTIONS_ROUTE },
  'PRC-09': { kind: 'exempt', reason: PROCESS_ACTIONS_ROUTE },
  'PRC-12': { kind: 'exempt', reason: PROCESS_TIMELINE_ROUTE },
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
  'TPL-10': { kind: 'exempt', reason: TEMPLATE_ROUTE },
  'TPL-11': { kind: 'exempt', reason: TEMPLATE_ROUTE },
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
